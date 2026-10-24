import { Test, TestingModule } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';

describe('AppModule (e2e)', () => {
  it('compiles and connects to the database', async () => {
    const module: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    try {
      expect(module.get(DataSource).isInitialized).toBe(true);
    } finally {
      await module.close();
    }
  });
});
