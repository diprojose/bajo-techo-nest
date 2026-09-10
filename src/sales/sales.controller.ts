import { Controller, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { SalesService } from './sales.service';
import { ListSalesDto } from './dto/list-sales.dto';
import { Usuario } from '../auth/usuario.decorator';
import type { UsuarioAutenticado } from '../auth/auth.guard';

@Controller('sales')
export class SalesController {
  constructor(private readonly salesService: SalesService) {}

  @Get()
  findAll(@Query() filtros: ListSalesDto) {
    return this.salesService.findAll(filtros);
  }

  @Get('recientes')
  findRecent(@Query() filtros: ListSalesDto) {
    return this.salesService.findRecent(filtros);
  }

  @Get('resumen')
  summary(@Usuario() usuario: UsuarioAutenticado, @Query() filtros: ListSalesDto) {
    return this.salesService.summary(usuario.id, filtros);
  }

  @Get(':id')
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.salesService.findOne(id);
  }
}
