import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  CORREOS,
  IDS,
  URL_API,
  afirmar,
  afirmarVacio,
  iniciarSesion,
  productoDe,
  type Sesion,
} from './ayudas';

/**
 * Aislamiento a nivel HTTP.
 *
 * Las pruebas de base de datos verifican que las políticas son correctas.
 * Estas verifican que el API las está USANDO.
 *
 * Es una distinción que importa: el día que alguien "optimice" un endpoint
 * lento cambiándolo a `service_role`, las políticas seguirán perfectas y las
 * pruebas de base de datos seguirán en verde, mientras el API reparte datos de
 * todas las marcas. Este archivo es lo único que atrapa ese día.
 */

let marcaA: Sesion;
let marcaB: Sesion;
let tienda: Sesion;
let productoB: Awaited<ReturnType<typeof productoDe>>;
let apiDisponible = false;

// Jest no tiene describe.runIf. Mismo efecto, explícito.
const describeApi = process.env.SKIP_API_TESTS === 'true' ? describe.skip : describe;

beforeAll(async () => {
  try {
    const ping = await fetch(`${URL_API}/api/health`, {
      signal: AbortSignal.timeout(3000),
    });
    apiDisponible = ping.ok;
  } catch {
    apiDisponible = false;
  }

  if (!apiDisponible) return;

  [marcaA, marcaB, tienda] = await Promise.all([
    iniciarSesion(CORREOS.nimvu),
    iniciarSesion(CORREOS.terracota),
    iniciarSesion(CORREOS.tienda),
  ]);
  productoB = await productoDe(IDS.marcaTerracota);
});

describeApi('API: aislamiento por HTTP', () => {
  it('el API responde (si falla, levante `npm run dev:api`)', () => {
    afirmar(
      apiDisponible,
      `El API no responde en ${URL_API}. Las pruebas de aislamiento por HTTP no se ejecutaron.`,
    );
  });

  it('GET /me devuelve el perfil propio y solo el propio', async () => {
    const respuesta = await marcaA.api('/me');
    expect(respuesta.status).toBe(200);

    const perfil = (await respuesta.json()) as { id: string; brand_id: string; role: string };
    expect(perfil.id).toBe(marcaA.userId);
    expect(perfil.brand_id).toBe(IDS.marcaNimvu);
    expect(perfil.role).toBe('brand');
  });

  it('GET /brands: una marca ve solo la suya; la tienda ve las tres', async () => {
    // No hay ningún `if (rol === "store")` en el controlador. La diferencia
    // sale sola de las políticas de RLS, que es exactamente lo que se quiere:
    // una sola definición del alcance, y vive en la base de datos.
    const [respuestaMarca, respuestaTienda] = await Promise.all([
      marcaA.api('/brands'),
      tienda.api('/brands'),
    ]);

    const deMarca = (await respuestaMarca.json()) as Array<{ id: string }>;
    const deTienda = (await respuestaTienda.json()) as Array<{ id: string }>;

    expect(deMarca).toHaveLength(1);
    expect(deMarca[0]!.id).toBe(IDS.marcaNimvu);
    expect(deTienda).toHaveLength(3);
  });

  it('GET /sales/recientes no trae ventas de la marca B', async () => {
    const respuesta = await marcaA.api('/sales/recientes');
    const ventas = (await respuesta.json()) as Array<{ brand_id: string }>;

    expect(ventas.length).toBeGreaterThan(0);
    expect(ventas.every((v) => v.brand_id === IDS.marcaNimvu)).toBe(true);
  });

  it('GET /sales/recientes?brandId=B devuelve vacío', async () => {
    const respuesta = await marcaA.api(`/sales/recientes?brandId=${IDS.marcaTerracota}`);
    expect(await respuesta.json()).toEqual([]);
  });

  it('GET /products solo devuelve productos de la marca del token', async () => {
    const respuesta = await marcaA.api('/products');
    expect(respuesta.status).toBe(200);

    const productos = (await respuesta.json()) as Array<{ brand_id: string }>;
    expect(productos.length).toBeGreaterThan(0);
    expect(productos.every((p) => p.brand_id === IDS.marcaNimvu)).toBe(true);
  });

  it('GET /products?brandId=B devuelve vacío, no los productos de B', async () => {
    const respuesta = await marcaA.api(`/products?brandId=${IDS.marcaTerracota}`);
    expect(respuesta.status).toBe(200);
    expect(await respuesta.json()).toEqual([]);
  });

  it('GET /products/conteo no cuenta los productos de B', async () => {
    const [respuestaA, respuestaB] = await Promise.all([
      marcaA.api('/products/conteo'),
      marcaB.api('/products/conteo'),
    ]);

    const { total: totalA } = (await respuestaA.json()) as { total: number };
    const { total: totalB } = (await respuestaB.json()) as { total: number };

    expect(totalA).toBeGreaterThan(0);
    expect(totalB).toBeGreaterThan(0);

    // Cada una cuenta lo suyo. Si el API usara service_role, ambas darían el
    // total de la base y este assert reventaría.
    const respuestaCruzada = await marcaA.api(`/products/conteo?brandId=${IDS.marcaTerracota}`);
    const { total: cruzado } = (await respuestaCruzada.json()) as { total: number };
    expect(cruzado).toBe(0);
  });

  it('GET /products/:id de un producto de B responde 404', async () => {
    const respuesta = await marcaA.api(`/products/${productoB.id}`);
    expect(respuesta.status).toBe(404);
  });

  it('PATCH /products/:id sobre un producto de B no lo modifica', async () => {
    const respuesta = await marcaA.api(`/products/${productoB.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ price: 1 }),
    });

    expect(respuesta.status).toBe(404);

    const verificacion = await marcaB.api(`/products/${productoB.id}`);
    const producto = (await verificacion.json()) as { price: number };
    expect(producto.price).toBe(productoB.price);
  });

  it('DELETE /products/:id sobre un producto de B no lo borra', async () => {
    const respuesta = await marcaA.api(`/products/${productoB.id}`, { method: 'DELETE' });
    expect(respuesta.status).toBe(404);

    const verificacion = await marcaB.api(`/products/${productoB.id}`);
    expect(verificacion.status).toBe(200);
  });

  it('POST /products con el brand_id de B es rechazado', async () => {
    const respuesta = await marcaA.api('/products', {
      method: 'POST',
      body: JSON.stringify({
        brand_id: IDS.marcaTerracota,
        name: `Intruso por HTTP ${Date.now()}`,
        price: 1000,
      }),
    });

    expect([403, 404]).toContain(respuesta.status);
  });

  it('el embed de ventas hacia productos no filtra productos de B', async () => {
    const respuesta = await marcaA.api('/sales');
    const ventas = (await respuesta.json()) as Array<{
      brand_id: string;
      sale_items: Array<{ brand_id: string; products: { brand_id: string } | null }>;
    }>;

    for (const venta of ventas) {
      expect(venta.brand_id).toBe(IDS.marcaNimvu);
      for (const linea of venta.sale_items ?? []) {
        expect(linea.products?.brand_id ?? IDS.marcaNimvu).toBe(IDS.marcaNimvu);
      }
    }
  });

  it('GET /sales/resumen agrega solo sobre las ventas propias', async () => {
    // Este endpoint usa SQL directo con `SET LOCAL role authenticated`.
    // Es el camino donde más fácil sería saltarse RLS sin darse cuenta.
    const respuesta = await marcaA.api('/sales/resumen');
    const resumen = (await respuesta.json()) as Array<{ brand_id: string; total: number }>;

    expect(resumen.every((f) => f.brand_id === IDS.marcaNimvu)).toBe(true);
  });

  it('sin token, el API responde 401 en todas las rutas de negocio', async () => {
    const rutas = ['/me', '/brands', '/products', '/products/conteo', '/sales', '/sales/recientes', '/sales/resumen'];

    for (const ruta of rutas) {
      const respuesta = await fetch(`${URL_API}/api${ruta}`);
      afirmar(respuesta.status === 401, `${ruta} debería exigir sesión, respondió ${respuesta.status}`);
    }
  });

  it('con un token inventado, el API responde 401', async () => {
    const respuesta = await fetch(`${URL_API}/api/products`, {
      headers: { Authorization: 'Bearer token.completamente.falso' },
    });

    expect(respuesta.status).toBe(401);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Prueba de código fuente.
//
// No consulta la base ni el API: lee los archivos. Atrapa la regresión antes
// de que llegue a comportarse mal, y da un mensaje que dice exactamente qué
// se rompió y por qué importa.
// ═══════════════════════════════════════════════════════════════════════════
describe('service_role está confinada', () => {
  const raizApi = join(process.cwd(), 'src');

  function archivosTs(directorio: string): string[] {
    const encontrados: string[] = [];
    for (const entrada of readdirSync(directorio)) {
      const ruta = join(directorio, entrada);
      if (statSync(ruta).isDirectory()) {
        encontrados.push(...archivosTs(ruta));
      } else if (entrada.endsWith('.ts')) {
        encontrados.push(ruta);
      }
    }
    return encontrados;
  }

  it('SUPABASE_SERVICE_ROLE_KEY solo se lee dentro de src/admin', () => {
    const infractores = archivosTs(raizApi)
      .filter((ruta) => !ruta.includes(`${join('src', 'admin')}`))
      .filter((ruta) => readFileSync(ruta, 'utf8').includes('SUPABASE_SERVICE_ROLE_KEY'));

    afirmarVacio(
      infractores,
      'La service_role key SALTA RLS. Fuera de src/admin, usarla convierte el aislamiento ' +
        'entre marcas en una convención de código en vez de una garantía de la base de datos.',
    );
  });

  it('AdminModule no exporta el cliente de service_role', () => {
    const fuente = readFileSync(join(raizApi, 'admin', 'admin.module.ts'), 'utf8');

    // Sin `exports`, ningún módulo de negocio puede inyectarlo.
    expect(fuente).not.toMatch(/exports\s*:/);
  });

  it('ningún módulo de negocio importa el símbolo del cliente de admin', () => {
    const infractores = archivosTs(raizApi)
      .filter((ruta) => !ruta.includes(`${join('src', 'admin')}`))
      .filter((ruta) => readFileSync(ruta, 'utf8').includes('SERVICE_ROLE_CLIENT'));

    expect(infractores).toEqual([]);
  });
});
