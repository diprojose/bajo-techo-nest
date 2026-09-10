import { config } from 'dotenv';

// .env.test primero: las pruebas nunca deben apuntar sin querer a producción.
config({ path: '.env.test' });
config({ path: '.env.local' });
config({ path: '.env' });

const requeridas = ['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY'];
const faltantes = requeridas.filter((v) => !process.env[v]);

if (faltantes.length > 0) {
  throw new Error(
    `Faltan variables para las pruebas: ${faltantes.join(', ')}.\n` +
      'Ejecute `npm run db:start`, copie las llaves que imprime y péguelas en .env.test ' +
      '(hay una plantilla en .env.example).',
  );
}

// Salvaguarda: estas pruebas escriben y borran datos.
const url = process.env.SUPABASE_URL ?? '';
const esLocal = url.includes('127.0.0.1') || url.includes('localhost');

if (!esLocal && process.env.PERMITIR_PRUEBAS_REMOTAS !== 'true') {
  throw new Error(
    `SUPABASE_URL apunta a ${url}, que no es local. Las pruebas de aislamiento crean y ` +
      'modifican datos. Si de verdad quiere correrlas contra ese entorno, exporte ' +
      'PERMITIR_PRUEBAS_REMOTAS=true.',
  );
}
