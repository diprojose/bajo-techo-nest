import { Injectable, NotFoundException } from '@nestjs/common';
import { RequestSupabaseService } from '../supabase/request-supabase.service';
import { traducirErrorPostgres } from '../common/errores-postgres';

/**
 * Perfil del usuario autenticado: rol, marca y tienda.
 *
 * El frontend lo usa para decidir qué DIBUJA, nunca qué puede ver. El alcance
 * de los datos lo decide RLS dentro de Postgres. Si esto devolviera un rol
 * equivocado, la interfaz se vería rara pero no se filtraría un solo dato.
 */
@Injectable()
export class MeService {
  constructor(private readonly supabase: RequestSupabaseService) {}

  async findProfile(userId: string) {
    // El filtro por id es necesario: un usuario de tienda ve los perfiles de
    // toda su tienda, así que sin él `maybeSingle()` fallaría con varias filas.
    const { data, error } = await this.supabase.db
      .from('profiles')
      .select('id, tenant_id, brand_id, role, full_name')
      .eq('id', userId)
      .maybeSingle();

    if (error) traducirErrorPostgres(error);
    if (!data) throw new NotFoundException('El usuario no tiene un perfil asignado');
    return data;
  }
}
