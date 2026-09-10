import { Global, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AuthGuard } from './auth.guard';
import { GlobalAuthGuard } from './global-auth.guard';

/**
 * Registra el guard global. No expone nada más: este módulo autentica, no
 * autoriza. Quién puede ver qué lo decide RLS dentro de Postgres.
 */
@Global()
@Module({
  providers: [AuthGuard, { provide: APP_GUARD, useClass: GlobalAuthGuard }],
  exports: [AuthGuard],
})
export class AuthModule {}
