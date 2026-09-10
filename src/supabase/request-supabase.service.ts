import { Inject, Injectable, Scope } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { REQUEST } from '@nestjs/core';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import type { Request } from 'express';

/**
 * Cliente de Supabase con la identidad del usuario que hizo la petición.
 *
 * Esta es la pieza que sostiene toda la garantía de aislamiento del producto.
 *
 * El error clásico al poner un backend delante de Supabase es que el backend
 * se conecte con la `service_role key`. Esa llave SALTA RLS por diseño de
 * Postgres. Si lo hiciéramos, el aislamiento entre marcas dejaría de ser una
 * propiedad de la base de datos y pasaría a depender de que cada consulta de
 * este API recuerde su `WHERE brand_id`. Un `WHERE` olvidado sería una fuga
 * entre marcas, y las pruebas de RLS seguirían pasando en verde porque las
 * políticas seguirían ahí, correctas, simplemente sin usarse.
 *
 * En vez de eso, propagamos el access token del usuario. Postgres corre como
 * rol `authenticated`, RLS se aplica sola, y este API no puede ver más de lo
 * que el usuario podría ver por su cuenta.
 *
 * Ámbito REQUEST: se crea uno por petición, atado a un token concreto.
 */
@Injectable({ scope: Scope.REQUEST })
export class RequestSupabaseService {
  private cliente: SupabaseClient | null = null;

  constructor(
    @Inject(REQUEST) private readonly request: Request,
    private readonly config: ConfigService,
  ) {}

  /**
   * Cliente atado al usuario actual. Toda consulta de negocio pasa por aquí.
   */
  get db(): SupabaseClient {
    if (this.cliente) return this.cliente;

    const url = this.config.getOrThrow<string>('SUPABASE_URL');
    const anonKey = this.config.getOrThrow<string>('SUPABASE_ANON_KEY');
    const token = this.extraerToken();

    this.cliente = createClient(url, anonKey, {
      global: { headers: { Authorization: `Bearer ${token}` } },
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });

    return this.cliente;
  }

  private extraerToken(): string {
    const header = this.request.headers.authorization ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (!token) {
      // AuthGuard ya debería haber rechazado la petición. Si llegamos aquí,
      // preferimos fallar a construir un cliente sin identidad.
      throw new Error('Petición sin token: no se puede construir el cliente de Supabase');
    }
    return token;
  }
}
