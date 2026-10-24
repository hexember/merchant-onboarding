import { KybCheckQueue } from './kyb-check.queue';
import { KybModule } from './kyb.module';

describe('KybModule', () => {
  it('exports only the producer, never the worker repository, processor or provider', () => {
    const exported: unknown = Reflect.getMetadata('exports', KybModule);

    expect(exported).toEqual([KybCheckQueue]);
  });
});
