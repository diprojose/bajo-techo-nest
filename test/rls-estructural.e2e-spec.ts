import { afirmarVacio } from './ayudas';
import { Client, type QueryResultRow } from 'pg';

/**
 * Meta-pruebas: la red que atrapa lo que todavía no existe.
 *
 * Las pruebas de aislamiento verifican las tablas de HOY. Estas verifican la
 * FORMA del esquema, así que atrapan el error del mes entrante: la tabla nueva
 * que alguien crea sin RLS, la vista de conveniencia que se lleva los datos
 * por encima de las políticas, la función `security definer` que alguien
 * agrega para "resolver rápido" un caso.
 *
 * Sin esto, romper el aislamiento es silencioso. Con esto, hace ruido.
 *
 * Se conecta como superusuario a propósito: son consultas al catálogo del
 * sistema, no al camino de datos que se está probando.
 */

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';

async function consultar<T extends QueryResultRow = Record<string, unknown>>(
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  const cliente = new Client({ connectionString: DATABASE_URL });
  await cliente.connect();
  try {
    const { rows } = await cliente.query<T>(sql, params);
    return rows;
  } finally {
    await cliente.end();
  }
}

/** Funciones `security definer` permitidas, con su razón de ser. */
const DEFINER_PERMITIDAS = new Set([
  // Leen `profiles` sin disparar las políticas de `profiles`: sin definer
  // habría recursión infinita al evaluar cualquier política.
  'app.current_tenant_id',
  'app.current_brand_id',
  'app.current_user_role',
  // Mantienen `products.stock`, que ningún cliente puede escribir.
  'app.apply_stock_delta',
  'app.sale_item_stock',
  'app.sale_void_stock',
  'app.restock_stock',
  'app.adjustment_stock',
  // Impide que alguien se ascienda editando su propio perfil.
  'app.guard_profile_identity',
]);

describe('RLS activo en todo el esquema', () => {
  it('toda tabla de public tiene row level security habilitado', async () => {
    const sinRls = await consultar<{ tabla: string }>(`
      select c.relname as tabla
        from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public'
         and c.relkind = 'r'
         and not c.relrowsecurity
       order by 1
    `);

    // Si esto falla, alguien creó una tabla y olvidó
    // `alter table ... enable row level security`.
    afirmarVacio(
      sinRls.map((f) => f.tabla),
      'Hay tablas sin RLS: sus filas son visibles para cualquier usuario autenticado',
    );
  });

  it('toda tabla de public tiene al menos una política', async () => {
    // RLS activo sin políticas niega todo, lo cual es seguro pero deja la
    // tabla inservible en silencio. Casi siempre significa un descuido.
    const sinPoliticas = await consultar<{ tabla: string }>(`
      select c.relname as tabla
        from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public'
         and c.relkind = 'r'
         and c.relrowsecurity
         and not exists (
           select 1 from pg_policy p where p.polrelid = c.oid
         )
       order by 1
    `);

    expect(sinPoliticas.map((f) => f.tabla)).toEqual([]);
  });

  it('ninguna política usa FOR ALL: cada comando se decide por separado', async () => {
    // `FOR ALL` hace que un permiso de lectura arrastre el de escritura.
    const paraTodo = await consultar<{ tabla: string; politica: string }>(`
      select c.relname as tabla, p.polname as politica
        from pg_policy p
        join pg_class c on c.oid = p.polrelid
        join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public'
         and p.polcmd = '*'
       order by 1, 2
    `);

    expect(paraTodo).toEqual([]);
  });

  it('toda política de INSERT y UPDATE tiene WITH CHECK', async () => {
    // Sin WITH CHECK, un usuario puede crear o mover una fila hacia otra marca.
    const sinCheck = await consultar<{ tabla: string; politica: string; comando: string }>(`
      select c.relname as tabla, p.polname as politica, p.polcmd::text as comando
        from pg_policy p
        join pg_class c on c.oid = p.polrelid
        join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public'
         and p.polcmd in ('a', 'w')   -- INSERT, UPDATE
         and p.polwithcheck is null
       order by 1, 2
    `);

    expect(sinCheck).toEqual([]);
  });

  it('las ventas no se pueden borrar: no hay política de DELETE', async () => {
    // Una venta que ya descontó inventario no se borra, se anula. Borrarla
    // rompería el reporte de forma silenciosa e irreproducible.
    const politicasDelete = await consultar<{ tabla: string }>(`
      select c.relname as tabla
        from pg_policy p
        join pg_class c on c.oid = p.polrelid
        join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public'
         and c.relname in ('sales', 'sale_items')
         and p.polcmd = 'd'
    `);

    expect(politicasDelete).toEqual([]);
  });
});

describe('Sin puertas traseras', () => {
  it('no hay funciones security definer fuera de la lista blanca', async () => {
    const definers = await consultar<{ nombre: string }>(`
      select n.nspname || '.' || p.proname as nombre
        from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
       where n.nspname in ('public', 'app')
         and p.prosecdef
       order by 1
    `);

    const inesperadas = definers
      .map((f) => f.nombre)
      .filter((nombre) => !DEFINER_PERMITIDAS.has(nombre));

    // Una función security definer corre con los permisos de quien la creó.
    // Cada una nueva es un posible bypass de RLS y necesita justificarse.
    afirmarVacio(
      inesperadas,
      'Funciones security definer no justificadas: cada una puede saltarse RLS',
    );
  });

  it('toda vista de public es security_invoker', async () => {
    // Una vista sin security_invoker ejecuta con los permisos de su creador:
    // un count() a través de ella cruzaría marcas aunque las tablas estén bien.
    const vistasInseguras = await consultar<{ vista: string }>(`
      select c.relname as vista
        from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public'
         and c.relkind = 'v'
         and coalesce(
               (select option_value
                  from pg_options_to_table(c.reloptions)
                 where option_name = 'security_invoker'),
               'false'
             ) <> 'true'
       order by 1
    `);

    afirmarVacio(
      vistasInseguras.map((f) => f.vista),
      'Vistas sin security_invoker: se saltan las políticas de las tablas que consultan',
    );
  });

  it('el rol anon no tiene permisos sobre ninguna tabla de negocio', async () => {
    const concedidos = await consultar<{ tabla: string; permiso: string }>(`
      select table_name as tabla, privilege_type as permiso
        from information_schema.role_table_grants
       where grantee = 'anon'
         and table_schema = 'public'
       order by 1, 2
    `);

    expect(concedidos).toEqual([]);
  });

  it('anon no puede ejecutar las funciones de contexto de RLS', async () => {
    const ejecutables = await consultar<{ nombre: string }>(`
      select p.proname as nombre
        from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'app'
         and has_function_privilege('anon', p.oid, 'execute')
       order by 1
    `);

    expect(ejecutables).toEqual([]);
  });
});

describe('El inventario cuadra por construcción', () => {
  it('el stock de todo producto es igual a la suma de sus movimientos', async () => {
    // stock = Σ ajustes + Σ reposiciones − Σ ventas (activas y que descuentan)
    //
    // Si esta igualdad se rompe, algún trigger se desincronizó y el stock pasó
    // a ser un número que alguien tocó en vez del resultado de hechos
    // registrados. Es un fallo silencioso: nada más lo delataría.
    const descuadres = await consultar<{
      name: string;
      recorded_stock: number;
      expected_stock: number;
    }>(`
      select name, recorded_stock, expected_stock
        from product_stock_ledger
       where recorded_stock <> expected_stock
       order by name
    `);

    afirmarVacio(descuadres, 'Hay productos cuyo stock no coincide con sus movimientos');
  });

  it('ningún producto quedó con stock negativo', async () => {
    const negativos = await consultar(`
      select id, name, stock from products where stock < 0
    `);

    expect(negativos).toEqual([]);
  });

  it('el total de toda venta es igual a la suma de sus líneas', async () => {
    // No hay forma de que falle: `line_total` es una columna generada y el
    // total se calcula desde las líneas. La prueba existe para que, si alguien
    // agrega una columna `total` denormalizada, quede constancia de que este
    // era el punto.
    const descuadres = await consultar(`
      select st.sale_id, st.total, coalesce(sum(si.quantity * si.unit_price), 0) as calculado
        from sale_totals st
        left join sale_items si on si.sale_id = st.sale_id
       group by st.sale_id, st.total
      having st.total <> coalesce(sum(si.quantity * si.unit_price), 0)
    `);

    expect(descuadres).toEqual([]);
  });
});
