-- ============================================================================
-- Bajo Techo — 04. Row Level Security
--
-- Regla del brief, sin excepciones ni bypass en el cliente:
--   * rol 'brand' → lee y escribe SOLO filas de su brand_id.
--   * rol 'store' → todas las marcas de su tenant_id, nunca de otro tenant.
--
-- Decisiones de implementación:
--   1. Política SEPARADA por comando. Nunca FOR ALL: un INSERT no puede
--      colarse por la puerta que abrió un SELECT.
--   2. WITH CHECK idéntico al USING: nadie puede crear ni MOVER una fila
--      hacia otra marca u otra tienda.
--   3. Sin política de DELETE en sales ni sale_items: las ventas no se borran,
--      se anulan (voided_at) y el trigger devuelve el stock.
--   4. Las funciones app.current_* son SECURITY DEFINER y por eso leen profiles
--      sin disparar las políticas de profiles → no hay recursión.
--   5. Toda vista se declara security_invoker: una vista SECURITY DEFINER es
--      el agujero clásico por donde un count() cruza marcas.
-- ============================================================================

-- ─── Contexto del usuario actual ────────────────────────────────────────────
create or replace function app.current_tenant_id()
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select p.tenant_id from public.profiles p where p.id = (select auth.uid())
$$;

create or replace function app.current_brand_id()
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select p.brand_id from public.profiles p where p.id = (select auth.uid())
$$;

create or replace function app.current_user_role()
returns public.user_role
language sql
stable
security definer
set search_path = ''
as $$
  select p.role from public.profiles p where p.id = (select auth.uid())
$$;

comment on function app.current_tenant_id() is
  'Tienda del usuario autenticado. SECURITY DEFINER para evitar recursión con las políticas de profiles.';

revoke all on function app.current_tenant_id(), app.current_brand_id(), app.current_user_role()
  from public, anon;
grant execute on function app.current_tenant_id(), app.current_brand_id(), app.current_user_role()
  to authenticated, service_role;

-- ─── Predicado de aislamiento ───────────────────────────────────────────────
-- Se usa idéntico en USING y en WITH CHECK de cada tabla de negocio.
create or replace function app.can_access(p_tenant_id uuid, p_brand_id uuid)
returns boolean
language sql
stable
as $$
  select
    case app.current_user_role()
      when 'store' then p_tenant_id = app.current_tenant_id()
      when 'brand' then p_tenant_id = app.current_tenant_id()
                     and p_brand_id = app.current_brand_id()
      else false
    end
$$;

revoke all on function app.can_access(uuid, uuid) from public, anon;
grant execute on function app.can_access(uuid, uuid) to authenticated, service_role;

-- ─── RLS activo en todas las tablas ─────────────────────────────────────────
alter table tenants           enable row level security;
alter table brands            enable row level security;
alter table profiles          enable row level security;
alter table products          enable row level security;
alter table product_aliases   enable row level security;
alter table sales             enable row level security;
alter table sale_items        enable row level security;
alter table restocks          enable row level security;
alter table stock_adjustments enable row level security;
alter table imports           enable row level security;
alter table import_rows       enable row level security;
alter table reports           enable row level security;

-- ─── tenants ────────────────────────────────────────────────────────────────
-- Solo la propia tienda, y solo lectura. Crear tiendas es operación de admin.
create policy tenants_select on tenants for select to authenticated
  using (id = app.current_tenant_id());

-- ─── brands ─────────────────────────────────────────────────────────────────
-- 'store' ve todas las marcas de su tienda; 'brand' ve únicamente la suya.
create policy brands_select on brands for select to authenticated
  using (app.can_access(tenant_id, id));

create policy brands_insert on brands for insert to authenticated
  with check (app.current_user_role() = 'store' and tenant_id = app.current_tenant_id());

create policy brands_update on brands for update to authenticated
  using      (app.current_user_role() = 'store' and tenant_id = app.current_tenant_id())
  with check (app.current_user_role() = 'store' and tenant_id = app.current_tenant_id());

-- ─── profiles ───────────────────────────────────────────────────────────────
-- Uno se ve a sí mismo; 'store' ve los perfiles de su tienda.
-- El UPDATE es solo sobre la propia fila y el trigger app.guard_profile_identity
-- impide cambiar role / brand_id / tenant_id (RLS filtra filas, no columnas).
create policy profiles_select on profiles for select to authenticated
  using (
    id = (select auth.uid())
    or (app.current_user_role() = 'store' and tenant_id = app.current_tenant_id())
  );

create policy profiles_update_self on profiles for update to authenticated
  using      (id = (select auth.uid()))
  with check (id = (select auth.uid()));

-- ─── products ───────────────────────────────────────────────────────────────
create policy products_select on products for select to authenticated
  using (app.can_access(tenant_id, brand_id));

create policy products_insert on products for insert to authenticated
  with check (app.can_access(tenant_id, brand_id));

create policy products_update on products for update to authenticated
  using      (app.can_access(tenant_id, brand_id))
  with check (app.can_access(tenant_id, brand_id));

create policy products_delete on products for delete to authenticated
  using (app.can_access(tenant_id, brand_id));

-- ─── product_aliases ────────────────────────────────────────────────────────
create policy product_aliases_select on product_aliases for select to authenticated
  using (app.can_access(tenant_id, brand_id));

create policy product_aliases_insert on product_aliases for insert to authenticated
  with check (app.can_access(tenant_id, brand_id));

create policy product_aliases_update on product_aliases for update to authenticated
  using      (app.can_access(tenant_id, brand_id))
  with check (app.can_access(tenant_id, brand_id));

create policy product_aliases_delete on product_aliases for delete to authenticated
  using (app.can_access(tenant_id, brand_id));

-- ─── sales ──────────────────────────────────────────────────────────────────
-- Sin política de DELETE: una venta que ya descontó inventario no se borra.
create policy sales_select on sales for select to authenticated
  using (app.can_access(tenant_id, brand_id));

create policy sales_insert on sales for insert to authenticated
  with check (app.can_access(tenant_id, brand_id));

create policy sales_update on sales for update to authenticated
  using      (app.can_access(tenant_id, brand_id))
  with check (app.can_access(tenant_id, brand_id));

-- ─── sale_items ─────────────────────────────────────────────────────────────
-- Tampoco se borran: se borran en cascada al borrar la venta, cosa que RLS
-- no permite hacer a ningún usuario.
create policy sale_items_select on sale_items for select to authenticated
  using (app.can_access(tenant_id, brand_id));

create policy sale_items_insert on sale_items for insert to authenticated
  with check (app.can_access(tenant_id, brand_id));

create policy sale_items_update on sale_items for update to authenticated
  using      (app.can_access(tenant_id, brand_id))
  with check (app.can_access(tenant_id, brand_id));

-- ─── restocks ───────────────────────────────────────────────────────────────
create policy restocks_select on restocks for select to authenticated
  using (app.can_access(tenant_id, brand_id));

create policy restocks_insert on restocks for insert to authenticated
  with check (app.can_access(tenant_id, brand_id));

-- ─── stock_adjustments ──────────────────────────────────────────────────────
create policy stock_adjustments_select on stock_adjustments for select to authenticated
  using (app.can_access(tenant_id, brand_id));

create policy stock_adjustments_insert on stock_adjustments for insert to authenticated
  with check (app.can_access(tenant_id, brand_id));

-- ─── imports ────────────────────────────────────────────────────────────────
create policy imports_select on imports for select to authenticated
  using (app.can_access(tenant_id, brand_id));

create policy imports_insert on imports for insert to authenticated
  with check (app.can_access(tenant_id, brand_id));

create policy imports_update on imports for update to authenticated
  using      (app.can_access(tenant_id, brand_id))
  with check (app.can_access(tenant_id, brand_id));

create policy imports_delete on imports for delete to authenticated
  using (app.can_access(tenant_id, brand_id));

-- ─── import_rows ────────────────────────────────────────────────────────────
create policy import_rows_select on import_rows for select to authenticated
  using (app.can_access(tenant_id, brand_id));

create policy import_rows_insert on import_rows for insert to authenticated
  with check (app.can_access(tenant_id, brand_id));

create policy import_rows_update on import_rows for update to authenticated
  using      (app.can_access(tenant_id, brand_id))
  with check (app.can_access(tenant_id, brand_id));

create policy import_rows_delete on import_rows for delete to authenticated
  using (app.can_access(tenant_id, brand_id));

-- ─── reports ────────────────────────────────────────────────────────────────
create policy reports_select on reports for select to authenticated
  using (app.can_access(tenant_id, brand_id));

create policy reports_insert on reports for insert to authenticated
  with check (app.can_access(tenant_id, brand_id));

create policy reports_delete on reports for delete to authenticated
  using (app.can_access(tenant_id, brand_id));
