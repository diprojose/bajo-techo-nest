import { Controller, Get } from '@nestjs/common';
import { MeService } from './me.service';
import { Usuario } from '../auth/usuario.decorator';
import type { UsuarioAutenticado } from '../auth/auth.guard';

@Controller('me')
export class MeController {
  constructor(private readonly meService: MeService) {}

  @Get()
  findProfile(@Usuario() usuario: UsuarioAutenticado) {
    return this.meService.findProfile(usuario.id);
  }
}
