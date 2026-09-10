import { SetMetadata } from '@nestjs/common';

export const ES_PUBLICO = 'es_publico';

/** Marca una ruta como abierta. Solo `/health` debería usarlo. */
export const Publico = () => SetMetadata(ES_PUBLICO, true);
