import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createRemoteJWKSet, decodeProtectedHeader, jwtVerify } from 'jose';
import type { Request } from 'express';

export interface UsuarioAutenticado {
  /** `auth.uid()` en Postgres. */
  id: string;
  email: string | null;
  /** El access token original, que se propaga tal cual a Postgres. */
  token: string;
}

declare module 'express' {
  interface Request {
    usuario?: UsuarioAutenticado;
  }
}

/**
 * Verifica la firma del access token de Supabase.
 *
 * Ojo con lo que este guard NO hace: no decide qué puede ver el usuario.
 * Solo confirma que el token es auténtico y extrae el `sub`. El rol, la marca
 * y la tienda se leen de `profiles` dentro de Postgres, donde viven las
 * políticas de RLS. Ningún claim del token determina el alcance de los datos:
 * si lo hiciera, alterar el token cambiaría lo que se ve.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  /** Claves públicas de Supabase, para los tokens asimétricos (ES256/RS256). */
  private readonly jwks: ReturnType<typeof createRemoteJWKSet>;
  /** Secreto compartido, para proyectos que todavía firman con HS256. */
  private readonly secreto: Uint8Array | null;

  constructor(config: ConfigService) {
    const urlSupabase = config.getOrThrow<string>('SUPABASE_URL');
    this.jwks = createRemoteJWKSet(new URL(`${urlSupabase}/auth/v1/.well-known/jwks.json`));

    const secreto = config.get<string>('SUPABASE_JWT_SECRET');
    this.secreto = secreto ? new TextEncoder().encode(secreto) : null;
  }

  async canActivate(contexto: ExecutionContext): Promise<boolean> {
    const request = contexto.switchToHttp().getRequest<Request>();
    const header = request.headers.authorization ?? '';

    if (!header.startsWith('Bearer ')) {
      throw new UnauthorizedException('Falta el token de sesión');
    }

    const token = header.slice(7);

    try {
      // Supabase firma con ES256 y publica las claves en JWKS; los proyectos
      // antiguos todavía usan HS256 con secreto compartido. Se elige según el
      // algoritmo que declara el token, nunca según lo que el token pida:
      // aceptar `alg: none` o dejar que el token escoja verificador es la
      // vulnerabilidad clásica de JWT.
      const { alg } = decodeProtectedHeader(token);

      const { payload } = alg?.startsWith('HS')
        ? await jwtVerify(token, this.exigirSecreto(), { algorithms: ['HS256'] })
        : await jwtVerify(token, this.jwks, { algorithms: ['ES256', 'RS256'] });

      if (typeof payload.sub !== 'string' || payload.sub.length === 0) {
        throw new UnauthorizedException('Token sin usuario');
      }

      // Un token de service_role no representa a una persona y saltaría RLS.
      // Nunca debe entrar por la puerta pública del API.
      if (payload.role === 'service_role') {
        throw new UnauthorizedException('Token no válido para esta operación');
      }

      request.usuario = {
        id: payload.sub,
        email: typeof payload.email === 'string' ? payload.email : null,
        token,
      };

      return true;
    } catch (error) {
      if (error instanceof UnauthorizedException) throw error;
      throw new UnauthorizedException('Sesión inválida o expirada');
    }
  }

  private exigirSecreto(): Uint8Array {
    if (!this.secreto) {
      throw new UnauthorizedException('El token usa HS256 pero no hay SUPABASE_JWT_SECRET configurado');
    }
    return this.secreto;
  }
}
