import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { AuthModule } from './auth/auth.module';
import { SupabaseModule } from './supabase/supabase.module';
import { AdminModule } from './admin/admin.module';
import { HealthModule } from './health/health.module';
import { MeModule } from './me/me.module';
import { BrandsModule } from './brands/brands.module';
import { ProductsModule } from './products/products.module';
import { SalesModule } from './sales/sales.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, envFilePath: ['.env.local', '.env'] }),
    AuthModule,
    SupabaseModule,
    AdminModule,
    HealthModule,
    MeModule,
    BrandsModule,
    ProductsModule,
    SalesModule,
  ],
})
export class AppModule {}
