import {
  CORREOS,
  IDS,
  clienteAdmin,
  clienteAnonimo,
  iniciarSesion,
  productoDe,
  ventaDe,
  type Sesion,
} from './ayudas';

/**
 * Aislamiento entre marcas — nivel base de datos.
 *
 * Del brief: "el fundador es dueño de una de las marcas del local. Una fuga de
 * datos entre marcas no es un bug, es el fin del producto."
 *
 * Marca A = Nimvu. Marca B = Terracota Viva. Ambas viven en Casa Alma, así que
 * comparten tenant: es el caso difícil, no el fácil. Si el aislamiento
 * funciona entre dos marcas de la misma tienda, funciona con más razón entre
 * tiendas distintas.
 *
 * Cada vector se prueba por separado porque cada uno falla distinto. Una
 * política puede estar bien para SELECT y mal para UPDATE; un `count()` puede
 * filtrar donde un `select` no; un join puede sacar por la puerta de atrás lo
 * que la consulta directa no da.
 */

let marcaA: Sesion;   // Nimvu
let marcaB: Sesion;   // Terracota Viva
let tienda: Sesion;   // Casa Alma
let productoB: Awaited<ReturnType<typeof productoDe>>;
let ventaB: Awaited<ReturnType<typeof ventaDe>>;

beforeAll(async () => {
  [marcaA, marcaB, tienda] = await Promise.all([
    iniciarSesion(CORREOS.nimvu),
    iniciarSesion(CORREOS.terracota),
    iniciarSesion(CORREOS.tienda),
  ]);

  productoB = await productoDe(IDS.marcaTerracota);
  ventaB = await ventaDe(IDS.marcaTerracota);
});

// ═══════════════════════════════════════════════════════════════════════════
// Controles positivos.
//
// Van primero a propósito. Sin ellos, una base vacía o unas políticas que
// niegan todo harían pasar cada prueba de aislamiento sin probar nada: "no ves
// nada de la marca B" se cumple trivialmente si tampoco ves nada tuyo.
// ═══════════════════════════════════════════════════════════════════════════
describe('Controles positivos: el sistema sí muestra lo propio', () => {
  it('la marca A ve sus propios productos', async () => {
    const { data, error } = await marcaA.db.from('products').select('*');

    expect(error).toBeNull();
    expect(data!.length).toBeGreaterThan(0);
    expect(data!.every((p) => p.brand_id === IDS.marcaNimvu)).toBe(true);
  });

  it('la marca A ve sus propias ventas', async () => {
    const { data, error } = await marcaA.db.from('sales').select('*');

    expect(error).toBeNull();
    expect(data!.length).toBeGreaterThan(0);
    expect(data!.every((v) => v.brand_id === IDS.marcaNimvu)).toBe(true);
  });

  it('el usuario de tienda ve las tres marcas de Casa Alma', async () => {
    const { data, error } = await tienda.db.from('brands').select('id, name');

    expect(error).toBeNull();
    expect(data).toHaveLength(3);
    expect(data!.map((m) => m.id).sort()).toEqual(
      [IDS.marcaNimvu, IDS.marcaTerracota, IDS.marcaHilo].sort(),
    );
  });

  it('el usuario de tienda ve productos de más de una marca', async () => {
    const { data } = await tienda.db.from('products').select('brand_id');
    const marcasVistas = new Set(data!.map((p) => p.brand_id));

    expect(marcasVistas.size).toBeGreaterThan(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Lectura
// ═══════════════════════════════════════════════════════════════════════════
describe('Lectura: la marca A no puede leer nada de la marca B', () => {
  it('un SELECT abierto no devuelve una sola fila de B', async () => {
    const { data } = await marcaA.db.from('products').select('*');

    expect(data!.some((p) => p.brand_id === IDS.marcaTerracota)).toBe(false);
  });

  it('pedir explícitamente la marca B devuelve cero filas, no un error', async () => {
    // Detalle importante: RLS no rechaza la consulta, la vacía. Un error
    // delataría que del otro lado hay algo; cero filas no dice nada.
    const { data, error } = await marcaA.db
      .from('products')
      .select('*')
      .eq('brand_id', IDS.marcaTerracota);

    expect(error).toBeNull();
    expect(data).toEqual([]);
  });

  it('pedir un producto de B por su id exacto no lo encuentra', async () => {
    const { data } = await marcaA.db
      .from('products')
      .select('*')
      .eq('id', productoB.id)
      .maybeSingle();

    expect(data).toBeNull();
  });

  it('la marca B tampoco ve nada de A: el aislamiento va en las dos vías', async () => {
    const { data } = await marcaB.db.from('products').select('*');

    expect(data!.length).toBeGreaterThan(0);
    expect(data!.every((p) => p.brand_id === IDS.marcaTerracota)).toBe(true);
  });

  it('la marca A no ve las ventas de B', async () => {
    const { data } = await marcaA.db.from('sales').select('*').eq('id', ventaB.id);

    expect(data).toEqual([]);
  });

  it('la marca A no ve las líneas de venta de B', async () => {
    const { data } = await marcaA.db
      .from('sale_items')
      .select('*')
      .eq('brand_id', IDS.marcaTerracota);

    expect(data).toEqual([]);
  });

  it('la marca A no ve el perfil del usuario de B', async () => {
    const { data } = await marcaA.db.from('profiles').select('*');

    expect(data!.every((p) => p.id === marcaA.userId)).toBe(true);
  });

  it('la marca A no ve la marca B en la tabla de marcas', async () => {
    const { data } = await marcaA.db.from('brands').select('*');

    expect(data).toHaveLength(1);
    expect(data![0]!.id).toBe(IDS.marcaNimvu);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Conteo y agregación
//
// El vector que más se olvida. Un count() puede filtrar información sin
// devolver una sola fila: basta con que el número revele cuántas hay.
// ═══════════════════════════════════════════════════════════════════════════
describe('Conteo y agregación: los números tampoco cruzan marcas', () => {
  it('count exacto sobre productos cuenta solo los de A', async () => {
    const admin = clienteAdmin();

    const { count: vistosPorA } = await marcaA.db
      .from('products')
      .select('*', { count: 'exact', head: true });

    const { count: realesDeA } = await admin
      .from('products')
      .select('*', { count: 'exact', head: true })
      .eq('brand_id', IDS.marcaNimvu);

    const { count: totalReal } = await admin
      .from('products')
      .select('*', { count: 'exact', head: true });

    expect(vistosPorA).toBe(realesDeA);
    // Y que no sea trivial: en la base hay muchos más productos que los de A.
    expect(totalReal!).toBeGreaterThan(vistosPorA!);
  });

  it('count filtrado por la marca B devuelve cero', async () => {
    const { count } = await marcaA.db
      .from('products')
      .select('*', { count: 'exact', head: true })
      .eq('brand_id', IDS.marcaTerracota);

    expect(count).toBe(0);
  });

  it('la suma de ventas por la vista sale_totals solo suma lo de A', async () => {
    const admin = clienteAdmin();

    const { data: vistoPorA } = await marcaA.db.from('sale_totals').select('brand_id, total');
    const { data: todo } = await admin.from('sale_totals').select('brand_id, total');

    const marcasEnLaVista = new Set(vistoPorA!.map((v) => v.brand_id));
    expect(marcasEnLaVista.size).toBeLessThanOrEqual(1);
    if (marcasEnLaVista.size === 1) {
      expect([...marcasEnLaVista][0]).toBe(IDS.marcaNimvu);
    }

    const sumaA = vistoPorA!.reduce((s, v) => s + v.total, 0);
    const sumaTotal = todo!.reduce((s, v) => s + v.total, 0);
    expect(sumaA).toBeLessThan(sumaTotal);
  });

  it('la vista de auditoría de inventario tampoco cruza marcas', async () => {
    const { data } = await marcaA.db.from('product_stock_ledger').select('brand_id');

    expect(data!.length).toBeGreaterThan(0);
    expect(data!.every((f) => f.brand_id === IDS.marcaNimvu)).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Joins y embeds
//
// La puerta de atrás: consultar la tabla propia y arrastrar la ajena.
// ═══════════════════════════════════════════════════════════════════════════
describe('Joins: no se puede sacar nada de B a través de una tabla propia', () => {
  it('un embed de ventas hacia productos no trae productos de B', async () => {
    const { data } = await marcaA.db
      .from('sales')
      .select('id, brand_id, sale_items(*, products(id, brand_id, name))');

    for (const venta of data ?? []) {
      expect(venta.brand_id).toBe(IDS.marcaNimvu);
      for (const linea of (venta.sale_items ?? []) as Array<{
        brand_id: string;
        products: { brand_id: string } | null;
      }>) {
        expect(linea.brand_id).toBe(IDS.marcaNimvu);
        expect(linea.products?.brand_id ?? IDS.marcaNimvu).toBe(IDS.marcaNimvu);
      }
    }
  });

  it('el embed inverso, de productos hacia ventas, tampoco filtra', async () => {
    const { data } = await marcaA.db.from('products').select('id, brand_id, sale_items(*)');

    for (const producto of data ?? []) {
      expect(producto.brand_id).toBe(IDS.marcaNimvu);
      for (const linea of (producto.sale_items ?? []) as Array<{ brand_id: string }>) {
        expect(linea.brand_id).toBe(IDS.marcaNimvu);
      }
    }
  });

  it('embeber la marca desde el producto no revela la marca B', async () => {
    const { data } = await marcaA.db.from('products').select('id, brands(id, name)');
    const marcas = new Set(
      (data ?? []).map((p) => (p.brands as unknown as { id: string } | null)?.id).filter(Boolean),
    );

    expect([...marcas]).toEqual([IDS.marcaNimvu]);
  });

  it('los alias de producto no filtran nombres del catálogo de B', async () => {
    const { data } = await marcaA.db
      .from('product_aliases')
      .select('brand_id')
      .eq('brand_id', IDS.marcaTerracota);

    expect(data).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Escritura
// ═══════════════════════════════════════════════════════════════════════════
describe('Escritura: la marca A no puede modificar nada de la marca B', () => {
  it('no puede crear un producto con el brand_id de B', async () => {
    const { error } = await marcaA.db.from('products').insert({
      tenant_id: IDS.tenantCasaAlma,
      brand_id: IDS.marcaTerracota,
      name: `Intento de intrusión ${Date.now()}`,
      price: 1000,
    });

    expect(error).not.toBeNull();
    expect(error!.code).toBe('42501'); // violación de RLS
  });

  it('no puede mover un producto propio hacia la marca B', async () => {
    // El WITH CHECK del UPDATE es lo que cierra esta puerta: sin él, una fila
    // propia podría "emigrar" al catálogo ajeno.
    const propio = await productoDe(IDS.marcaNimvu);

    const { data, error } = await marcaA.db
      .from('products')
      .update({ brand_id: IDS.marcaTerracota })
      .eq('id', propio.id)
      .select();

    const bloqueado = error !== null || (data ?? []).length === 0;
    expect(bloqueado).toBe(true);

    const admin = clienteAdmin();
    const { data: despues } = await admin
      .from('products')
      .select('brand_id')
      .eq('id', propio.id)
      .single();
    expect(despues!.brand_id).toBe(IDS.marcaNimvu);
  });

  it('un UPDATE sobre un producto de B no afecta ni una fila, y B queda intacto', async () => {
    const precioAntes = productoB.price;

    const { data, error } = await marcaA.db
      .from('products')
      .update({ price: 1 })
      .eq('id', productoB.id)
      .select();

    expect(error).toBeNull();
    expect(data).toEqual([]); // cero filas afectadas

    // La verificación que de verdad importa: leída con el oráculo, la fila de
    // B sigue como estaba. Sin esto, la prueba solo confirmaría que A no vio
    // el resultado, no que no cambió nada.
    const admin = clienteAdmin();
    const { data: despues } = await admin
      .from('products')
      .select('price')
      .eq('id', productoB.id)
      .single();

    expect(despues!.price).toBe(precioAntes);
  });

  it('un DELETE sobre un producto de B no borra nada', async () => {
    const { data, error } = await marcaA.db
      .from('products')
      .delete()
      .eq('id', productoB.id)
      .select();

    expect(error).toBeNull();
    expect(data).toEqual([]);

    const admin = clienteAdmin();
    const { count } = await admin
      .from('products')
      .select('*', { count: 'exact', head: true })
      .eq('id', productoB.id);

    expect(count).toBe(1); // sigue vivo
  });

  it('no puede registrar una venta a nombre de la marca B', async () => {
    const { error } = await marcaA.db.from('sales').insert({
      tenant_id: IDS.tenantCasaAlma,
      brand_id: IDS.marcaTerracota,
      payment_method: 'card',
      voucher_number: `INTRUSO-${Date.now()}`,
      recorded_by: marcaA.userId,
    });

    expect(error).not.toBeNull();
    expect(error!.code).toBe('42501');
  });

  it('no puede colar un producto de B en una venta propia', async () => {
    // Doble candado: RLS lo bloquea, y si RLS fallara, la FK compuesta
    // (product_id, brand_id) haría el insert imposible de todas formas.
    const { data: venta } = await marcaA.db
      .from('sales')
      .select('id')
      .limit(1)
      .single();

    const { error } = await marcaA.db.from('sale_items').insert({
      sale_id: venta!.id,
      tenant_id: IDS.tenantCasaAlma,
      brand_id: IDS.marcaNimvu,
      product_id: productoB.id, // producto ajeno
      quantity: 1,
      unit_price: 1000,
    });

    expect(error).not.toBeNull();
    expect(['42501', '23503']).toContain(error!.code);
  });

  it('no puede anular una venta de la marca B', async () => {
    const { data, error } = await marcaA.db
      .from('sales')
      .update({ voided_at: new Date().toISOString(), voided_by: marcaA.userId })
      .eq('id', ventaB.id)
      .select();

    expect(error).toBeNull();
    expect(data).toEqual([]);

    const admin = clienteAdmin();
    const { data: despues } = await admin
      .from('sales')
      .select('voided_at')
      .eq('id', ventaB.id)
      .single();

    expect(despues!.voided_at).toBeNull();
  });

  it('no puede inyectar un ajuste de inventario en el stock de B', async () => {
    const { error } = await marcaA.db.from('stock_adjustments').insert({
      tenant_id: IDS.tenantCasaAlma,
      brand_id: IDS.marcaTerracota,
      product_id: productoB.id,
      delta: -999,
      reason: 'shrinkage',
      created_by: marcaA.userId,
    });

    expect(error).not.toBeNull();
    expect(error!.code).toBe('42501');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Escalada de privilegios
// ═══════════════════════════════════════════════════════════════════════════
describe('Escalada: nadie se asciende a sí mismo', () => {
  it('un usuario de marca no puede cambiarse el rol a tienda', async () => {
    // RLS filtra filas, no columnas: la fila del propio perfil SÍ es
    // actualizable. Lo que cierra esta puerta es el trigger
    // app.guard_profile_identity.
    const { error } = await marcaA.db
      .from('profiles')
      .update({ role: 'store' })
      .eq('id', marcaA.userId);

    expect(error).not.toBeNull();

    const admin = clienteAdmin();
    const { data } = await admin.from('profiles').select('role').eq('id', marcaA.userId).single();
    expect(data!.role).toBe('brand');
  });

  it('un usuario de marca no puede reasignarse a la marca B', async () => {
    const { error } = await marcaA.db
      .from('profiles')
      .update({ brand_id: IDS.marcaTerracota })
      .eq('id', marcaA.userId);

    expect(error).not.toBeNull();

    const admin = clienteAdmin();
    const { data } = await admin
      .from('profiles')
      .select('brand_id')
      .eq('id', marcaA.userId)
      .single();
    expect(data!.brand_id).toBe(IDS.marcaNimvu);
  });

  it('un usuario de marca no puede cambiarse de tienda', async () => {
    const { error } = await marcaA.db
      .from('profiles')
      .update({ tenant_id: '99999999-9999-4999-8999-999999999991' })
      .eq('id', marcaA.userId);

    expect(error).not.toBeNull();
  });

  it('nadie puede editar el perfil de otro usuario', async () => {
    const { data, error } = await marcaA.db
      .from('profiles')
      .update({ full_name: 'Secuestrado' })
      .eq('id', IDS.usuarioTerracota)
      .select();

    const bloqueado = error !== null || (data ?? []).length === 0;
    expect(bloqueado).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Anónimo
// ═══════════════════════════════════════════════════════════════════════════
describe('Sin sesión: no existe nada', () => {
  const tablas = [
    'tenants',
    'brands',
    'profiles',
    'products',
    'product_aliases',
    'sales',
    'sale_items',
    'restocks',
    'stock_adjustments',
    'imports',
    'import_rows',
    'reports',
  ] as const;

  it.each(tablas)('un visitante anónimo no obtiene nada de %s', async (tabla) => {
    const anonimo = clienteAnonimo();
    const { data, error } = await anonimo.from(tabla).select('*');

    // Vale cualquiera de las dos: permiso denegado, o cero filas.
    const sinAcceso = error !== null || (data ?? []).length === 0;
    expect(sinAcceso).toBe(true);
  });
});
