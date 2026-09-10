-- ============================================================================
-- Bajo Techo — Datos semilla del demo de Casa Alma
--
-- Se ejecuta automáticamente con `npm run db:reset`.
--
--   1 tienda   : Casa Alma
--   3 marcas   : Nimvu (real) + Terracota Viva y Hilo de Agua (ficticias)
--   3 usuarios : 1 de tienda + 2 de marca
--                (dos de marca porque los tests de aislamiento necesitan
--                 probar el cruce A → B con usuarios distintos)
--
-- Contraseña de todos los usuarios: demo-bajo-techo-2026
--
-- El catálogo de Nimvu son las referencias canónicas deducidas del archivo
-- real REPORTE NIMVU OFICIAL.xlsx, con sus nombres sucios cargados como alias.
-- Las fotos van con placeholder: el Excel no traía imágenes embebidas.
-- ============================================================================

-- ─── Identificadores fijos, para que los tests puedan referenciarlos ────────
-- Son UUID v4 válidos (nibble de versión 4, nibble de variante 8): Postgres
-- acepta cualquier cosa con la forma correcta, pero la validación del API sí
-- verifica versión y variante, y datos semilla inválidos la harían fallar.
--   tienda    11111111-1111-4111-8111-111111111111
--   marcas    22222222-2222-4222-8222-22222222222[1-3]
--   usuarios  33333333-3333-4333-8333-33333333333[1-3]

-- ─── Usuarios de autenticación ──────────────────────────────────────────────
-- Las columnas de token van en cadena vacía, NO en NULL: GoTrue las lee como
-- texto no nulo y un NULL hace fallar todo inicio de sesión con
-- "Database error querying schema", que no dice nada sobre la causa real.
insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password,
  email_confirmed_at, created_at, updated_at,
  raw_app_meta_data, raw_user_meta_data,
  confirmation_token, recovery_token,
  email_change_token_new, email_change_token_current, email_change,
  phone_change, phone_change_token, reauthentication_token
)
select
  '00000000-0000-0000-0000-000000000000',
  u.id, 'authenticated', 'authenticated', u.email,
  extensions.crypt('demo-bajo-techo-2026', extensions.gen_salt('bf')),
  now(), now(), now(),
  '{"provider":"email","providers":["email"]}', '{}',
  '', '', '', '', '', '', '', ''
from (values
  ('33333333-3333-4333-8333-333333333331'::uuid, 'tienda@casaalma.test'),
  ('33333333-3333-4333-8333-333333333332'::uuid, 'nimvu@bajotecho.test'),
  ('33333333-3333-4333-8333-333333333333'::uuid, 'terracota@bajotecho.test')
) as u(id, email);

insert into auth.identities (
  id, user_id, provider_id, identity_data, provider, last_sign_in_at, created_at, updated_at
)
select
  gen_random_uuid(), u.id, u.id::text,
  json_build_object('sub', u.id::text, 'email', u.email)::jsonb,
  'email', now(), now(), now()
from auth.users u
where u.email in ('tienda@casaalma.test', 'nimvu@bajotecho.test', 'terracota@bajotecho.test');

-- ─── Tienda ─────────────────────────────────────────────────────────────────
insert into tenants (id, name) values
  ('11111111-1111-4111-8111-111111111111', 'Casa Alma');

-- ─── Marcas ─────────────────────────────────────────────────────────────────
insert into brands (id, tenant_id, name, monthly_fee, is_active) values
  ('22222222-2222-4222-8222-222222222221',
   '11111111-1111-4111-8111-111111111111', 'Nimvu',           850000, true),
  ('22222222-2222-4222-8222-222222222222',
   '11111111-1111-4111-8111-111111111111', 'Terracota Viva',  850000, true),
  ('22222222-2222-4222-8222-222222222223',
   '11111111-1111-4111-8111-111111111111', 'Hilo de Agua',    720000, true);

-- ─── Perfiles ───────────────────────────────────────────────────────────────
insert into profiles (id, tenant_id, brand_id, role, full_name) values
  ('33333333-3333-4333-8333-333333333331',
   '11111111-1111-4111-8111-111111111111', null,
   'store', 'Mostrador Casa Alma'),
  ('33333333-3333-4333-8333-333333333332',
   '11111111-1111-4111-8111-111111111111',
   '22222222-2222-4222-8222-222222222221',
   'brand', 'Nimvu'),
  ('33333333-3333-4333-8333-333333333333',
   '11111111-1111-4111-8111-111111111111',
   '22222222-2222-4222-8222-222222222222',
   'brand', 'Terracota Viva');

-- ─── Catálogo de Nimvu ──────────────────────────────────────────────────────
-- Referencias canónicas: las 12 que quedan tras deduplicar el Excel real.
insert into products (id, tenant_id, brand_id, sku, name, price, min_stock)
select
  gen_random_uuid(),
  '11111111-1111-4111-8111-111111111111',
  '22222222-2222-4222-8222-222222222221',
  'NIM-' || lpad(row_number() over (order by v.name)::text, 3, '0'),
  v.name,
  v.price,
  3
from (values
  ('Portavasos monstera de mesa set x6',              60000),
  ('Portavasos monstera de mesa set x6 verde y blanca', 60000),
  ('Portavasos monstera set x6 beige',                60000),
  ('Portavasos monstera set x6 verde',                60000),
  ('Portavasos monstera set x6 rosada',               60000),
  ('Portavasos monstera sencillo set x4',             40000),
  ('Portavasos otoño',                                50000),
  ('Portavasos cactus',                               70000),
  ('Portavasos anturio set x6 morado',                60000),
  ('Portavasos anturio rojo set x6',                  60000),
  ('Portavasos hojas verdes con blanco y amarillo',   60000),
  ('Portavasos verde',                                60000)
) as v(name, price);

-- Alias: los nombres sucios tal como venían escritos en el Excel.
-- Con esto, la próxima importación ya no vuelve a preguntar por ellos.
insert into product_aliases (tenant_id, brand_id, product_id, raw_name, confirmed_by)
select
  p.tenant_id, p.brand_id, p.id, a.raw_name,
  '33333333-3333-4333-8333-333333333331'
from products p
join (values
  ('Portavasos monstera de mesa set x6',
   'portavasos planta monstera de mesa se X6 unidadades'),
  ('Portavasos monstera de mesa set x6',
   'Portavasos planta monstera de mesa x6 unidades'),
  ('Portavasos monstera de mesa set x6 verde y blanca',
   'portavasos planta monstera de mesa se X6 unidadades verde y blanca'),
  ('Portavasos monstera set x6 beige',   'portavasos monstera x6 beige'),
  ('Portavasos monstera set x6 verde',   'portavasos monstera x6 verde'),
  ('Portavasos monstera set x6 rosada',
   'portavasos planta monstera de mesa set x6 unidades rosada'),
  ('Portavasos monstera sencillo set x4',
   'portavaso monstera sencillo sencillo set x4'),
  ('Portavasos otoño',                   'Porta vasos otoño'),
  ('Portavasos otoño',                   'portavasos otoño'),
  ('Portavasos anturio rojo set x6',     'portavasos anturio rojo x6'),
  ('Portavasos hojas verdes con blanco y amarillo',
   'portavasos hojas verdes con blanco y amarillo')
) as a(canonical_name, raw_name) on a.canonical_name = p.name
where p.brand_id = '22222222-2222-4222-8222-222222222221'
  and app.normalize(a.raw_name) is distinct from app.normalize(a.canonical_name);

-- ─── Catálogo de las dos marcas ficticias (40 referencias cada una) ─────────
insert into products (tenant_id, brand_id, sku, name, price, min_stock)
select
  '11111111-1111-4111-8111-111111111111',
  '22222222-2222-4222-8222-222222222222',
  'TER-' || lpad((row_number() over ())::text, 3, '0'),
  t.tipo || ' ' || f.acabado,
  t.precio_base + f.recargo,
  3
from (values
  ('Maceta de barro',      45000),
  ('Jarrón artesanal',     78000),
  ('Plato decorativo',     32000),
  ('Taza de cerámica',     28000),
  ('Cuenco tallado',       38000),
  ('Florero pequeño',      52000),
  ('Bandeja de arcilla',   61000),
  ('Portavelas',           24000)
) as t(tipo, precio_base)
cross join (values
  ('esmaltado blanco',  8000),
  ('terracota natural',    0),
  ('gres oscuro',      12000),
  ('rústico arena',     5000),
  ('vidriado azul',    15000)
) as f(acabado, recargo);

insert into products (tenant_id, brand_id, sku, name, price, min_stock)
select
  '11111111-1111-4111-8111-111111111111',
  '22222222-2222-4222-8222-222222222223',
  'HIL-' || lpad((row_number() over ())::text, 3, '0'),
  t.tipo || ' ' || f.color,
  t.precio_base + f.recargo,
  2
from (values
  ('Bolso tejido',        95000),
  ('Individual de fique', 34000),
  ('Camino de mesa',      72000),
  ('Cojín bordado',       58000),
  ('Tapete pequeño',     120000),
  ('Cesta de palma',      46000),
  ('Servilletero',        19000),
  ('Manta de algodón',   145000)
) as t(tipo, precio_base)
cross join (values
  ('crudo',        0),
  ('índigo',    9000),
  ('ocre',      6000),
  ('verde oliva', 6000),
  ('terracota', 4000)
) as f(color, recargo);

-- ─── Inventario inicial ─────────────────────────────────────────────────────
-- El stock nunca se escribe directo: entra como ajuste auditado y el trigger
-- lo aplica. Así la igualdad stock = Σ ajustes + Σ reposiciones − Σ ventas
-- se cumple desde la primera fila.
insert into stock_adjustments (tenant_id, brand_id, product_id, delta, reason, note, created_by)
select
  p.tenant_id, p.brand_id, p.id,
  8 + (abs(hashtext(p.id::text)) % 15),   -- entre 8 y 22 unidades
  'initial_inventory',
  'Carga inicial del catálogo para el demo',
  '33333333-3333-4333-8333-333333333331'
from products p;

-- ─── Algunas ventas de la semana en curso ───────────────────────────────────
-- Incluye a propósito una venta de dos productos con un solo vaucher: es el
-- caso que el modelo cabecera + líneas representa bien y el modelo plano no.
with nueva_venta as (
  insert into sales (id, tenant_id, brand_id, payment_method, voucher_number, sold_at, recorded_by)
  values (
    '44444444-4444-4444-8444-444444444441',
    '11111111-1111-4111-8111-111111111111',
    '22222222-2222-4222-8222-222222222221',
    'card', '154156', now() - interval '2 days',
    '33333333-3333-4333-8333-333333333331'
  )
  returning id, tenant_id, brand_id
)
insert into sale_items (sale_id, tenant_id, brand_id, product_id, quantity, unit_price)
select v.id, v.tenant_id, v.brand_id, p.id, 1, p.price
from nueva_venta v
join products p
  on p.brand_id = v.brand_id
 and p.name in ('Portavasos monstera de mesa set x6', 'Portavasos cactus');

with nueva_venta as (
  insert into sales (id, tenant_id, brand_id, payment_method, voucher_number, sold_at, recorded_by)
  values (
    '44444444-4444-4444-8444-444444444442',
    '11111111-1111-4111-8111-111111111111',
    '22222222-2222-4222-8222-222222222221',
    'cash', null, now() - interval '1 day',
    '33333333-3333-4333-8333-333333333331'
  )
  returning id, tenant_id, brand_id
)
insert into sale_items (sale_id, tenant_id, brand_id, product_id, quantity, unit_price)
select v.id, v.tenant_id, v.brand_id, p.id, 2, p.price
from nueva_venta v
join products p
  on p.brand_id = v.brand_id
 and p.name = 'Portavasos otoño';

with nueva_venta as (
  insert into sales (id, tenant_id, brand_id, payment_method, voucher_number, sold_at, recorded_by)
  values (
    '44444444-4444-4444-8444-444444444443',
    '11111111-1111-4111-8111-111111111111',
    '22222222-2222-4222-8222-222222222222',
    'card', 'UGF9', now() - interval '3 hours',
    '33333333-3333-4333-8333-333333333331'
  )
  returning id, tenant_id, brand_id
)
insert into sale_items (sale_id, tenant_id, brand_id, product_id, quantity, unit_price)
select v.id, v.tenant_id, v.brand_id, p.id, 1, p.price
from nueva_venta v
join products p
  on p.brand_id = v.brand_id
 and p.sku = 'TER-001';
