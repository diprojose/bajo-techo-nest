import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import type { UsuarioAutenticado } from './auth.guard';

/** Inyecta el usuario que AuthGuard ya verificó. */
export const Usuario = createParamDecorator(
  (_dato: unknown, contexto: ExecutionContext): UsuarioAutenticado => {
    const request = contexto.switchToHttp().getRequest<Request>();
    if (!request.usuario) {
      throw new Error('Usuario ausente: la ruta debe estar protegida por AuthGuard');
    }
    return request.usuario;
  },
);
