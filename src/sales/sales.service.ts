import { Injectable, NotFoundException } from '@nestjs/common';
import { ListSalesDto } from './dto/list-sales.dto';
import { RequestSupabaseService } from '../supabase/request-supabase.service';
import { RlsPoolService } from '../supabase/rls-pool.service';
import { traducirErrorPostgres } from '../common/errores-postgres';

interface FilaResumen {
  brand_id: string;
  ventas: string;
  unidades: string;
  total: string;
}

/**
 * Lectura de ventas.
 *
 * El registro de venta desde el mostrador llega en el siguiente paso. Estos
 * métodos cubren por ahora los vectores que una consulta directa no prueba:
 * el join hacia otra marca y la agregación.
 */
@Injectable()
export class SalesService {
  constructor(
    private readonly supabase: RequestSupabaseService,
    private readonly pool: RlsPoolService,
  ) {}

  async findAll(filtros: ListSalesDto) {
    // El embed hacia `products` es el vector de fuga por join: si las políticas
    // de `products` estuvieran mal, aquí saldrían productos ajenos.
    let consulta = this.supabase.db
      .from('sales')
      .select('*, sale_items(*, products(id, name, brand_id))')
      .order('sold_at', { ascending: false });

    if (filtros.brandId) consulta = consulta.eq('brand_id', filtros.brandId);

    const { data, error } = await consulta;
    if (error) traducirErrorPostgres(error);
    return data;
  }

  async findRecent(filtros: ListSalesDto) {
    // Desde la vista sale_totals: el total sale de la suma de las líneas, no de
    // una columna almacenada que pudiera haberse desincronizado.
    let consulta = this.supabase.db
      .from('sale_totals')
      .select(
        'sale_id, brand_id, sale_date, sold_at, payment_method, voucher_number, item_count, total_units, total',
      )
      .is('voided_at', null)
      .order('sold_at', { ascending: false })
      .limit(20);

    if (filtros.brandId) consulta = consulta.eq('brand_id', filtros.brandId);

    const { data, error } = await consulta;
    if (error) traducirErrorPostgres(error);
    return data;
  }

  /**
   * Agregado por marca, vía SQL directo con `SET LOCAL role authenticated`.
   * La suma se calcula dentro de Postgres, DESPUÉS de que RLS filtró las filas:
   * un SUM nunca puede sumar lo que el usuario no puede ver.
   */
  async summary(userId: string, filtros: ListSalesDto) {
    return this.pool.comoUsuario(userId, async (cliente) => {
      const { rows } = await cliente.query<FilaResumen>(
        `select brand_id,
                count(*)                      as ventas,
                coalesce(sum(total_units), 0) as unidades,
                coalesce(sum(total), 0)       as total
           from sale_totals
          where voided_at is null
            and ($1::uuid is null or brand_id = $1::uuid)
          group by brand_id`,
        [filtros.brandId ?? null],
      );

      return rows.map((fila) => ({
        brand_id: fila.brand_id,
        ventas: Number(fila.ventas),
        unidades: Number(fila.unidades),
        total: Number(fila.total), // COP, entero
      }));
    });
  }

  async findOne(id: string) {
    const { data, error } = await this.supabase.db
      .from('sales')
      .select('*, sale_items(*, products(id, name))')
      .eq('id', id)
      .maybeSingle();

    if (error) traducirErrorPostgres(error);
    if (!data) throw new NotFoundException('Venta no encontrada');
    return data;
  }
}
