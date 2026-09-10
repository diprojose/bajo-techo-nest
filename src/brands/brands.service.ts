import { Injectable } from '@nestjs/common';
import { RequestSupabaseService } from '../supabase/request-supabase.service';
import { traducirErrorPostgres } from '../common/errores-postgres';

/**
 * Marcas visibles para el usuario.
 *
 * Un usuario de tienda recibe las marcas de su tienda; uno de marca recibe
 * exactamente una: la suya. Esa diferencia no está programada aquí — no hay un
 * `if (rol === 'store')` en ninguna parte. Sale sola de las políticas de RLS,
 * que es justo lo que queremos: una sola definición del alcance, en la base.
 */
@Injectable()
export class BrandsService {
  constructor(private readonly supabase: RequestSupabaseService) {}

  async findAll() {
    const { data, error } = await this.supabase.db
      .from('brands')
      .select('id, tenant_id, name, monthly_fee, is_active')
      .order('name', { ascending: true });

    if (error) traducirErrorPostgres(error);
    return data;
  }
}
