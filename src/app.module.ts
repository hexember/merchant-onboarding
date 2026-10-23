import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

// Root module. Feature modules are added here by later tasks.
@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true })],
})
export class AppModule {}
