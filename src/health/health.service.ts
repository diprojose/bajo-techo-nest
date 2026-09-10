import { Injectable } from '@nestjs/common';
import { RlsPoolService } from '../supabase/rls-pool.service';

@Injectable()
export class HealthService {
  constructor(private readonly pool: RlsPoolService) {}

  async check() {
    const inicio = Date.now();
    try {
      await this.pool.verificarConexion();
      return {
        estado: 'ok',
        baseDeDatos: 'ok',
        latenciaMs: Date.now() - inicio,
        momento: new Date().toISOString(),
      };
    } catch {
      return {
        estado: 'degradado',
        baseDeDatos: 'sin conexión',
        latenciaMs: Date.now() - inicio,
        momento: new Date().toISOString(),
      };
    }
  }
}
