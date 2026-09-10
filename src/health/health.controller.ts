import { Controller, Get } from '@nestjs/common';
import { HealthService } from './health.service';
import { Publico } from '../auth/publico.decorator';

/**
 * Punto de despertar.
 *
 * Render en plan gratuito suspende el servicio tras ~15 minutos sin tráfico y
 * tarda cerca de un minuto en revivir. Un ping externo cada 5 minutos contra
 * esta ruta lo mantiene despierto.
 *
 * Toca la base de datos a propósito: los proyectos gratuitos de Supabase se
 * pausan tras ~7 días sin actividad, así que el mismo ping mantiene vivos a los
 * dos. Aun así, lo más confiable para la reunión sigue siendo abrir la app
 * cinco minutos antes.
 */
@Controller('health')
export class HealthController {
  constructor(private readonly healthService: HealthService) {}

  @Publico()
  @Get()
  check() {
    return this.healthService.check();
  }
}
