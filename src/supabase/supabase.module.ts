import { Global, Module } from '@nestjs/common';
import { RequestSupabaseService } from './request-supabase.service';
import { RlsPoolService } from './rls-pool.service';

/**
 * Solo expone los dos accesos que respetan RLS.
 *
 * El cliente con `service_role` NO vive aquí: está confinado en AdminModule,
 * para que ningún módulo de negocio pueda inyectarlo por accidente. Hay un
 * test que verifica que sigue siendo así.
 */
@Global()
@Module({
  providers: [RequestSupabaseService, RlsPoolService],
  exports: [RequestSupabaseService, RlsPoolService],
})
export class SupabaseModule {}
