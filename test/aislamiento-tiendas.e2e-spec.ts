import {
  CORREOS,
  IDS,
  IDS_OTRA_TIENDA,
  clienteAdmin,
  iniciarSesion,
  prepararOtraTienda,
  type Sesion,
} from './ayudas';

/**
 * Aislamiento entre tiendas.
 *
 * Del brief: "un usuario de tienda puede leer todas las marcas de su
 * tenant_id, nunca de otro tenant."
 *
 * El usuario de tienda es el que más permisos tiene del sistema, así que es el
 * que más lejos podría llegar si el predicado de RLS estuviera mal escrito.
 * La segunda tienda existe solo para estas pruebas: no va en el seed del demo.
 */

let tiendaCasaAlma: Sesion;
let marcaOtraTienda: Sesion;
let productoAjenoId: string;

beforeAll(async () => {
  const preparado = await prepararOtraTienda();
  productoAjenoId = preparado.productoId;

  [tiendaCasaAlma, marcaOtraTienda] = await Promise.all([
    iniciarSesion(CORREOS.tienda),
    iniciarSesion(IDS_OTRA_TIENDA.correo),
  ]);
});

describe('El usuario de tienda no cruza a otro tenant', () => {
  it('no ve la otra tienda en la tabla de tiendas', async () => {
    const { data } = await tiendaCasaAlma.db.from('tenants').select('*');

    expect(data).toHaveLength(1);
    expect(data![0]!.id).toBe(IDS.tenantCasaAlma);
  });

  it('no ve las marcas de la otra tienda', async () => {
    const { data } = await tiendaCasaAlma.db.from('brands').select('id, tenant_id');

    expect(data!.every((m) => m.tenant_id === IDS.tenantCasaAlma)).toBe(true);
    expect(data!.some((m) => m.id === IDS_OTRA_TIENDA.marca)).toBe(false);
  });

  it('no ve los productos de la otra tienda ni pidiéndolos por id', async () => {
    const { data } = await tiendaCasaAlma.db
      .from('products')
      .select('*')
      .eq('id', productoAjenoId);

    expect(data).toEqual([]);
  });

  it('el conteo de productos excluye a la otra tienda', async () => {
    const admin = clienteAdmin();

    const { count: visto } = await tiendaCasaAlma.db
      .from('products')
      .select('*', { count: 'exact', head: true });

    const { count: deCasaAlma } = await admin
      .from('products')
      .select('*', { count: 'exact', head: true })
      .eq('tenant_id', IDS.tenantCasaAlma);

    const { count: total } = await admin
      .from('products')
      .select('*', { count: 'exact', head: true });

    expect(visto).toBe(deCasaAlma);
    expect(total!).toBeGreaterThan(visto!);
  });

  it('no puede crear una marca en la otra tienda', async () => {
    const { error } = await tiendaCasaAlma.db.from('brands').insert({
      tenant_id: IDS_OTRA_TIENDA.tenant,
      name: `Marca intrusa ${Date.now()}`,
    });

    expect(error).not.toBeNull();
    expect(error!.code).toBe('42501');
  });

  it('no puede crear un producto en la otra tienda', async () => {
    const { error } = await tiendaCasaAlma.db.from('products').insert({
      tenant_id: IDS_OTRA_TIENDA.tenant,
      brand_id: IDS_OTRA_TIENDA.marca,
      name: `Producto intruso ${Date.now()}`,
      price: 5000,
    });

    expect(error).not.toBeNull();
    expect(error!.code).toBe('42501');
  });

  it('no puede modificar un producto de la otra tienda', async () => {
    const { data, error } = await tiendaCasaAlma.db
      .from('products')
      .update({ price: 1 })
      .eq('id', productoAjenoId)
      .select();

    expect(error).toBeNull();
    expect(data).toEqual([]);

    const admin = clienteAdmin();
    const { data: despues } = await admin
      .from('products')
      .select('price')
      .eq('id', productoAjenoId)
      .single();

    expect(despues!.price).toBe(33000);
  });

  it('no ve los perfiles de usuarios de la otra tienda', async () => {
    const { data } = await tiendaCasaAlma.db.from('profiles').select('id, tenant_id');

    expect(data!.every((p) => p.tenant_id === IDS.tenantCasaAlma)).toBe(true);
  });
});

describe('La marca de la otra tienda tampoco ve Casa Alma', () => {
  it('no ve productos de ninguna marca de Casa Alma', async () => {
    const { data } = await marcaOtraTienda.db.from('products').select('tenant_id');

    expect(data!.every((p) => p.tenant_id === IDS_OTRA_TIENDA.tenant)).toBe(true);
  });

  it('no ve las ventas de Nimvu', async () => {
    const { data } = await marcaOtraTienda.db
      .from('sales')
      .select('*')
      .eq('brand_id', IDS.marcaNimvu);

    expect(data).toEqual([]);
  });

  it('no ve Casa Alma en la tabla de tiendas', async () => {
    const { data } = await marcaOtraTienda.db.from('tenants').select('id');

    expect(data!.some((t) => t.id === IDS.tenantCasaAlma)).toBe(false);
  });
});
