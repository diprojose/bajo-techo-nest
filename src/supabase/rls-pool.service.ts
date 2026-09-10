import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pool, type PoolClient } from 'pg';

/**
 * SQL directo contra Postgres, con RLS activo.
 *
 * `RequestSupabaseService` cubre el CRUD normal vía PostgREST. Para las
 * consultas pesadas —agregados del reporte semanal, el importador cruzando
 * cientos de filas— hace falta SQL de verdad. Este pool lo da sin renunciar
 * al aislamiento:
 *
 *   1. La conexión usa un rol de login dedicado con NOBYPASSRLS. Nunca el
 *      superusuario ni el dueño de las tablas: aunque el paso 2 fallara, la
 *      conexión seguiría sin poder saltarse las políticas.
 *   2. Cada transacción hace `SET LOCAL role authenticated` y publica los
 *      claims del JWT, que es exactamente de donde `auth.uid()` los lee.
 *
 * El resultado: las mismas políticas, los mismos resultados que vería el
 * usuario consultando por su cuenta.
 */
@Injectable()
export class RlsPoolService implements OnModuleDestroy {
  private readonly pool: Pool;

  constructor(config: ConfigService) {
    this.pool = new Pool({
      connectionString: config.getOrThrow<string>('DATABASE_URL'),
      max: 5, // Render free: 512MB de RAM, no hay margen para más.
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
    });
  }

  /**
   * Ejecuta `fn` dentro de una transacción con la identidad del usuario.
   * Todo lo que se consulte adentro pasa por RLS.
   */
  async comoUsuario<T>(
    userId: string,
    fn: (cliente: PoolClient) => Promise<T>,
  ): Promise<T> {
    const cliente = await this.pool.connect();
    try {
      await cliente.query('begin');
      await cliente.query('set local role authenticated');
      await cliente.query('select set_config($1, $2, true)', [
        'request.jwt.claims',
        JSON.stringify({ sub: userId, role: 'authenticated' }),
      ]);

      const resultado = await fn(cliente);
      await cliente.query('commit');
      return resultado;
    } catch (error) {
      await cliente.query('rollback').catch(() => undefined);
      throw error;
    } finally {
      // `reset all` limpia el rol y los claims antes de devolver la conexión
      // al pool: una conexión reutilizada nunca hereda otra identidad.
      await cliente.query('reset all').catch(() => undefined);
      cliente.release();
    }
  }

  async verificarConexion(): Promise<void> {
    await this.pool.query('select 1');
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
  }
}
