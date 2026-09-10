import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient, SupabaseClient } from '@supabase/supabase-js';

export const SERVICE_ROLE_CLIENT = Symbol('SERVICE_ROLE_CLIENT');

/**
 * La única frontera del sistema donde vive `service_role`.
 *
 * Esa llave SALTA RLS. Por eso este módulo no la exporta: no está en el
 * contenedor global y ningún módulo de negocio puede inyectarla, ni por
 * descuido ni "temporalmente para arreglar una consulta lenta". Ese descuido
 * es exactamente la forma en que un sistema con RLS correcto termina filtrando
 * datos entre marcas.
 *
 * Usos legítimos, y son estos dos nada más:
 *   1. Crear usuarios (invitar una marca nueva), porque `auth.admin` lo exige.
 *   2. Los seeds.
 *
 * Nunca para leer ni escribir datos de negocio. Hay un test que verifica que
 * este símbolo no aparezca fuera de esta carpeta.
 */
@Module({
  providers: [
    {
      provide: SERVICE_ROLE_CLIENT,
      inject: [ConfigService],
      useFactory: (config: ConfigService): SupabaseClient =>
        createClient(
          config.getOrThrow<string>('SUPABASE_URL'),
          config.getOrThrow<string>('SUPABASE_SERVICE_ROLE_KEY'),
          { auth: { persistSession: false, autoRefreshToken: false } },
        ),
    },
  ],
  // Sin `exports`: a propósito.
})
export class AdminModule {}
