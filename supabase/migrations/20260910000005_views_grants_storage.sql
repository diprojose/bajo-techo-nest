-- ============================================================================
-- Bajo Techo — 05. Vistas, grants y Storage
--
-- TODA vista lleva security_invoker = true. Una vista SECURITY DEFINER (el
-- default histórico de Postgres) ejecuta con los permisos de quien la creó,
-- así que un count() o un sum() a través de ella cruzaría marcas aunque las
-- tablas estén perfectamente protegidas. Hay un test que lo verifica.
-- ============================================================================

-- ─── Total de una venta ─────────────────────────────────────────────────────
-- sales NO tiene columna `total`: una columna generada no puede sumar filas
-- hijas, y un total mantenido por trigger es justo el número que se
-- desincroniza en silencio. Se calcula siempre desde las líneas.
create view sale_totals
with (security_invoker = true) as
  select
    s.id                                as sale_id,
    s.tenant_id,
    s.brand_id,
    s.sale_date,
    s.sold_at,
    s.payment_method,
    s.voucher_number,
    s.voided_at,
    count(si.id)                        as item_count,
    coalesce(sum(si.quantity), 0)::int  as total_units,
    coalesce(sum(si.line_total), 0)::int as total
  from sales s
  left join sale_items si on si.sale_id = s.id
  group by s.id;

comment on view sale_totals is
  'Total en COP calculado desde las líneas. Los totales del reporte cuadran por construcción, no por mantenimiento.';

-- ─── Auditoría del inventario ───────────────────────────────────────────────
-- expected_stock debe ser siempre igual a products.stock. Un test lo verifica
-- para todos los productos: si un trigger se desincroniza, la suite lo grita.
create view product_stock_ledger
with (security_invoker = true) as
  select
    p.id         as product_id,
    p.tenant_id,
    p.brand_id,
    p.name,
    p.stock      as recorded_stock,
    coalesce(adj.total, 0) + coalesce(res.total, 0) - coalesce(sol.total, 0) as expected_stock,
    coalesce(adj.total, 0) as adjusted_units,
    coalesce(res.total, 0) as restocked_units,
    coalesce(sol.total, 0) as sold_units
  from products p
  left join lateral (
    select sum(a.delta)::int as total
      from stock_adjustments a where a.product_id = p.id
  ) adj on true
  left join lateral (
    select sum(r.quantity)::int as total
      from restocks r where r.product_id = p.id
  ) res on true
  left join lateral (
    select sum(si.quantity)::int as total
      from sale_items si
      join sales s on s.id = si.sale_id
     where si.product_id = p.id
       and s.affects_stock
       and s.voided_at is null
  ) sol on true;

-- ─── Reposición sugerida (portal de marca) ──────────────────────────────────
create view low_stock_products
with (security_invoker = true) as
  select p.*
    from products p
   where p.is_active
     and p.stock <= p.min_stock;

-- ─── Grants ─────────────────────────────────────────────────────────────────
-- anon no toca absolutamente nada. authenticated recibe permisos amplios y es
-- RLS quien decide qué filas ve: el filtrado vive en la base de datos.
revoke all on all tables    in schema public from anon;
revoke all on all sequences in schema public from anon;
revoke all on all functions in schema public from anon;

grant usage on schema public to authenticated;
grant select, insert, update, delete on all tables in schema public to authenticated;
grant usage, select on all sequences in schema public to authenticated;

-- Estas dos tablas jamás se escriben desde la app.
revoke insert, update, delete on tenants  from authenticated;
revoke insert, delete          on profiles from authenticated;

-- Las vistas son de solo lectura.
revoke insert, update, delete on sale_totals, product_stock_ledger, low_stock_products
  from authenticated;

alter default privileges in schema public
  revoke all on tables from anon;

-- Postgres concede EXECUTE a PUBLIC sobre toda función nueva, y anon está
-- dentro de PUBLIC. Sin esto, `anon` conserva permiso de ejecución sobre los
-- helpers de RLS y los triggers de inventario. No alcanza para leer datos
-- (no tiene USAGE sobre el esquema `app`), pero es superficie que no debería
-- existir. Se quita a todos y se devuelve solo a quien la necesita.
revoke all on all functions in schema app from public, anon;
grant execute on all functions in schema app to authenticated, service_role;

alter default privileges in schema app
  revoke all on functions from public, anon;

-- ─── Storage: fotos de producto ─────────────────────────────────────────────
-- Bucket privado. La ruta empieza por el brand_id, y las políticas espejan
-- exactamente las reglas de las tablas.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'product-photos', 'product-photos', false, 5242880,
  array['image/jpeg', 'image/png', 'image/webp']
)
on conflict (id) do nothing;

create policy product_photos_select on storage.objects for select to authenticated
  using (
    bucket_id = 'product-photos'
    and (
      (app.current_user_role() = 'store'
        and exists (select 1 from brands b
                     where b.id::text = (storage.foldername(name))[1]
                       and b.tenant_id = app.current_tenant_id()))
      or (app.current_user_role() = 'brand'
        and (storage.foldername(name))[1] = app.current_brand_id()::text)
    )
  );

create policy product_photos_insert on storage.objects for insert to authenticated
  with check (
    bucket_id = 'product-photos'
    and exists (
      select 1 from brands b
       where b.id::text = (storage.foldername(name))[1]
         and app.can_access(b.tenant_id, b.id)
    )
  );

create policy product_photos_delete on storage.objects for delete to authenticated
  using (
    bucket_id = 'product-photos'
    and exists (
      select 1 from brands b
       where b.id::text = (storage.foldername(name))[1]
         and app.can_access(b.tenant_id, b.id)
    )
  );
