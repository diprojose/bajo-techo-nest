import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { AuthGuard } from './auth.guard';
import { ES_PUBLICO } from './publico.decorator';

/**
 * Autenticación cerrada por defecto.
 *
 * Se aplica a TODA ruta del API salvo las marcadas con `@Publico()`. Así, un
 * endpoint nuevo nace protegido: olvidarse de un guard no puede abrir una
 * puerta, porque la puerta viene cerrada de fábrica.
 */
@Injectable()
export class GlobalAuthGuard implements CanActivate {
  private readonly authGuard: AuthGuard;

  constructor(
    private readonly reflector: Reflector,
    config: ConfigService,
  ) {
    this.authGuard = new AuthGuard(config);
  }

  canActivate(contexto: ExecutionContext): Promise<boolean> | boolean {
    const esPublico = this.reflector.getAllAndOverride<boolean>(ES_PUBLICO, [
      contexto.getHandler(),
      contexto.getClass(),
    ]);

    if (esPublico) return true;
    return this.authGuard.canActivate(contexto);
  }
}
