import 'reflect-metadata';
import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function arrancar(): Promise<void> {
  const app = await NestFactory.create(AppModule, { bufferLogs: false });

  app.setGlobalPrefix('api');

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      // Un campo no declarado en el DTO es un error, no algo a ignorar en
      // silencio: así un `brand_id` colado en el cuerpo se rechaza en la
      // puerta, antes de llegar siquiera a las políticas.
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
    }),
  );

  const origenes = (process.env.CORS_ORIGINS ?? 'http://localhost:3000')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);

  app.enableCors({
    origin: origenes,
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
  });

  // Render inyecta PORT; en local, 3001 para no chocar con Next.
  const puerto = Number(process.env.PORT ?? 3001);
  await app.listen(puerto, '0.0.0.0');

  Logger.log(`API de Bajo Techo escuchando en el puerto ${puerto}`, 'Arranque');
}

void arrancar();
