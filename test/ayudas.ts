import { createClient, type SupabaseClient } from '@supabase/supabase-js';

/**
 * Arnés de las pruebas de aislamiento.
 *
 * Regla de oro: los clientes de prueba se autentican DE VERDAD, con
 * `signInWithPassword` y la anon key. Corren como rol `authenticated`, igual
 * que un usuario real.
 *
 * Si en vez de eso usáramos la conexión de administración —o la service_role,
 * o el dueño de las tablas— saltaríamos RLS y la suite entera pasaría en
 * verde sin haber probado absolutamente nada. Es la forma más fácil de
 * escribir pruebas de aislamiento que no prueban el aislamiento.
 *
 * `service_role` se usa aquí para exactamente dos cosas, ambas fuera del
 * camino que se está probando:
 *   1. Montar los datos del segundo tenant.
 *   2. Ser el oráculo: verificar que la fila que un atacante intentó tocar
 *      efectivamente sigue existiendo y sin cambios.
 */

export const URL_SUPABASE = process.env.SUPABASE_URL ?? 'http://127.0.0.1:54321';
export const ANON_KEY = process.env.SUPABASE_ANON_KEY ?? '';
export const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
export const URL_API = process.env.API_URL ?? 'http://127.0.0.1:3001';

export const CLAVE_DEMO = 'demo-bajo-techo-2026';

/** Identificadores fijos del seed. */
export const IDS = {
  tenantCasaAlma: '11111111-1111-4111-8111-111111111111',
  marcaNimvu: '22222222-2222-4222-8222-222222222221',
  marcaTerracota: '22222222-2222-4222-8222-222222222222',
  marcaHilo: '22222222-2222-4222-8222-222222222223',
  usuarioTienda: '33333333-3333-4333-8333-333333333331',
  usuarioNimvu: '33333333-3333-4333-8333-333333333332',
  usuarioTerracota: '33333333-3333-4333-8333-333333333333',
} as const;

/** Segundo tenant, creado solo para las pruebas: no va en el seed del demo. */
export const IDS_OTRA_TIENDA = {
  tenant: '99999999-9999-4999-8999-999999999991',
  marca: '99999999-9999-4999-8999-999999999992',
  usuario: '99999999-9999-4999-8999-999999999993',
  correo: 'otra-tienda@prueba.test',
} as const;

export const CORREOS = {
  tienda: 'tienda@casaalma.test',
  nimvu: 'nimvu@bajotecho.test',
  terracota: 'terracota@bajotecho.test',
} as const;

export interface Sesion {
  db: SupabaseClient;
  userId: string;
  token: string;
  /** Llama al API de NestJS con esta identidad. */
  api: (ruta: string, init?: RequestInit) => Promise<Response>;
}

export function clienteAdmin(): SupabaseClient {
  if (!SERVICE_KEY) {
    throw new Error(
      'Falta SUPABASE_SERVICE_ROLE_KEY. Ejecute `supabase start` y copie las llaves a .env.test',
    );
  }
  return createClient(URL_SUPABASE, SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/** Cliente sin sesión: representa a un visitante anónimo. */
export function clienteAnonimo(): SupabaseClient {
  return createClient(URL_SUPABASE, ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export async function iniciarSesion(correo: string, clave = CLAVE_DEMO): Promise<Sesion> {
  const db = createClient(URL_SUPABASE, ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data, error } = await db.auth.signInWithPassword({ email: correo, password: clave });

  if (error || !data.session) {
    throw new Error(`No se pudo iniciar sesión como ${correo}: ${error?.message ?? 'sin sesión'}`);
  }

  const token = data.session.access_token;

  return {
    db,
    userId: data.session.user.id,
    token,
    api: (ruta, init) =>
      fetch(`${URL_API}/api${ruta}`, {
        ...init,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
          ...init?.headers,
        },
      }),
  };
}

/**
 * Crea la segunda tienda, con su marca, su usuario y un producto propio.
 * Idempotente: se puede correr muchas veces sin ensuciar nada.
 */
export async function prepararOtraTienda(): Promise<{ productoId: string }> {
  const admin = clienteAdmin();

  const { data: existentes } = await admin.auth.admin.listUsers();
  const yaExiste = existentes?.users.some((u) => u.email === IDS_OTRA_TIENDA.correo);

  if (!yaExiste) {
    const { error } = await admin.auth.admin.createUser({
      // El id lo fijamos para que las pruebas puedan referenciarlo.
      id: IDS_OTRA_TIENDA.usuario,
      email: IDS_OTRA_TIENDA.correo,
      password: CLAVE_DEMO,
      email_confirm: true,
    } as never);
    if (error) throw new Error(`No se pudo crear el usuario de la otra tienda: ${error.message}`);
  }

  await admin.from('tenants').upsert({ id: IDS_OTRA_TIENDA.tenant, name: 'Tienda Prueba Aislamiento' });

  await admin.from('brands').upsert({
    id: IDS_OTRA_TIENDA.marca,
    tenant_id: IDS_OTRA_TIENDA.tenant,
    name: 'Marca de otra tienda',
    monthly_fee: 500000,
  });

  await admin.from('profiles').upsert({
    id: IDS_OTRA_TIENDA.usuario,
    tenant_id: IDS_OTRA_TIENDA.tenant,
    brand_id: IDS_OTRA_TIENDA.marca,
    role: 'brand',
    full_name: 'Marca de otra tienda',
  });

  const { data: producto } = await admin
    .from('products')
    .upsert(
      {
        tenant_id: IDS_OTRA_TIENDA.tenant,
        brand_id: IDS_OTRA_TIENDA.marca,
        name: 'Producto de otra tienda',
        price: 33000,
      },
      { onConflict: 'brand_id,normalized_name' },
    )
    .select('id')
    .single();

  if (!producto) throw new Error('No se pudo preparar el producto de la otra tienda');
  return { productoId: producto.id };
}

/** Un producto cualquiera de la marca indicada, leído con el oráculo. */
export async function productoDe(brandId: string) {
  const admin = clienteAdmin();
  const { data, error } = await admin
    .from('products')
    .select('*')
    .eq('brand_id', brandId)
    .limit(1)
    .single();

  if (error || !data) throw new Error(`No hay productos sembrados para la marca ${brandId}`);
  return data;
}

/** Una venta cualquiera de la marca indicada. */
export async function ventaDe(brandId: string) {
  const admin = clienteAdmin();
  const { data, error } = await admin
    .from('sales')
    .select('*')
    .eq('brand_id', brandId)
    .limit(1)
    .single();

  if (error || !data) throw new Error(`No hay ventas sembradas para la marca ${brandId}`);
  return data;
}

/**
 * Afirma con un mensaje propio.
 *
 * `expect(valor, mensaje)` existe en Vitest pero NO en Jest, y estos mensajes
 * son medio punto de la suite: cuando una prueba de aislamiento falla, lo que
 * importa no es ver un diff sino entender de inmediato qué garantía se rompió.
 */
export function afirmar(condicion: boolean, mensaje: string): void {
  if (!condicion) throw new Error(mensaje);
}

/** Igual que arriba, pero para listas que deben estar vacías. */
export function afirmarVacio(lista: unknown[], mensaje: string): void {
  if (lista.length > 0) {
    throw new Error(`${mensaje}\n\n${JSON.stringify(lista, null, 2)}`);
  }
}
