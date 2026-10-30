import { describe, expect, test } from 'bun:test';
import { PlanConfigSchema, WorkflowDefinitionSchema } from '../src/lib/schemas';

describe('workflow DSL schema', () => {
  test('accepts nested groups with all step types', () => {
    const r = WorkflowDefinitionSchema.safeParse({
      steps: [
        { type: 'page', name: 'Home', url: '/', assets: true, extract: [{ var: 'p', from: 'html', selector: 'a', attr: 'href', pick: 'random' }] },
        { type: 'group', name: 'Browse', probability: 0.5, repeat: { min: 1, max: 3 }, steps: [{ type: 'think', min: 1, max: 2 }, { type: 'set', vars: { a: '1' } }] },
        { type: 'request', name: 'API', method: 'POST', url: '/api', body: { mode: 'json', content: { a: 1 } }, checks: [{ type: 'status', value: [200, 201] }] },
      ],
    });
    expect(r.success).toBe(true);
  });

  test('rejects missing names, bad variable names and empty flows', () => {
    expect(WorkflowDefinitionSchema.safeParse({ steps: [] }).success).toBe(false);
    expect(WorkflowDefinitionSchema.safeParse({ steps: [{ type: 'request', url: '/' }] }).success).toBe(false);
    expect(WorkflowDefinitionSchema.safeParse({ steps: [{ type: 'page', name: 'x', url: '/', extract: [{ var: '1bad', from: 'json' }] }] }).success).toBe(false);
  });

  test('plan config fills defaults', () => {
    const p = PlanConfigSchema.parse({ flows: [{ workflowId: '11111111-1111-4111-8111-111111111111' }], profile: { kind: 'smoke' } });
    expect(p.flows[0].weight).toBe(1);
    expect(p.autoStop).toMatchObject({ enabled: false, windowSec: 10, graceSec: 15 });
  });
});
