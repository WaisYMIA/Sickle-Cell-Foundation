import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { execFileSync } from 'child_process';
import * as path from 'path';
import { Pool } from 'pg';
import { AppModule } from '../src/app.module';
import { EmailService, MailMessage } from '../src/modules/email/email.service';

/**
 * PolicyService exists to let an admin view and record the 11 governance
 * decisions (docs/OPEN_ITEMS.md's "the constant") once they're actually
 * made elsewhere -- it does not decide anything itself. This suite checks
 * the admin-only surface added for that: a non-admin is denied, the list
 * contains the seeded PROVISIONAL rows, an update changes the value
 * without touching approval fields, and moving status to APPROVED sets
 * approved_by/approved_at exactly once (a later value-only edit of an
 * already-approved policy must not reset them).
 */
describe('Policy (governance decisions) admin endpoints (e2e, real database)', () => {
  let app: INestApplication;
  let pool: Pool;
  const run = Date.now();
  const sent: MailMessage[] = [];
  const fakeEmail: Partial<EmailService> = { send: async (m: MailMessage) => { sent.push(m); }, appBaseUrl: () => 'http://localhost:8000' };
  const http = () => request(app.getHttpServer());
  const linkToken = (text: string) => new URL(text.match(/https?:\/\/\S+/)![0]).searchParams.get('token')!;
  const lastEmailTo = (to: string) => [...sent].reverse().find((m) => m.to === to)!;
  const STRONG_PASSWORD = 'Correct-Horse-9!';

  async function loginAsFreshAdmin(label: string) {
    const email = `policy-admin-${label}-${run}@example.test`;
    const scriptPath = path.join(__dirname, '..', 'scripts', 'create-admin.js');
    const output = execFileSync('node', [scriptPath, email, '--force'], { env: process.env, encoding: 'utf-8' });
    const password = output.match(/Password:\s*(\S+)/)![1];
    const login = await http().post('/auth/login').send({ email, password }).expect(201);
    return { Authorization: `Bearer ${login.body.access_token}` };
  }

  let adminAuth: { Authorization: string };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(EmailService).useValue(fakeEmail).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
    adminAuth = await loginAsFreshAdmin('a');
  });
  afterAll(async () => { await app.close(); await pool.end(); });

  it('an unauthenticated request is rejected', async () => {
    await http().get('/admin/policy').expect(401);
  });

  it('an authenticated non-admin (a plain donor) is denied, not just unauthenticated', async () => {
    const email = `policy-donor-${run}@example.test`;
    await http().post('/auth/signup').send({ email, password: STRONG_PASSWORD, firstName: 'Plain', lastName: 'Donor' }).expect(201);
    await http().get(`/auth/activate?token=${linkToken(lastEmailTo(email).text)}`).expect(200);
    const login = await http().post('/auth/login').send({ email, password: STRONG_PASSWORD }).expect(201);
    await http().get('/admin/policy').set({ Authorization: `Bearer ${login.body.access_token}` }).expect(403);
  });

  it('lists the seeded governance decisions, all PROVISIONAL', async () => {
    const res = await http().get('/admin/policy').set(adminAuth).expect(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThanOrEqual(11);
    const hosting = res.body.find((p: any) => p.policy_key === 'HOSTING_JURISDICTION');
    expect(hosting).toBeDefined();
    expect(hosting.status).toBe('PROVISIONAL');
    expect(hosting.approved_by).toBeNull();
  });

  it('reads one policy by key, and 404s on an unknown key', async () => {
    const res = await http().get('/admin/policy/HOSTING_JURISDICTION').set(adminAuth).expect(200);
    expect(res.body.policy_key).toBe('HOSTING_JURISDICTION');
    await http().get('/admin/policy/NOT_A_REAL_KEY').set(adminAuth).expect(404);
  });

  it('updates a value without touching status/approval fields', async () => {
    const before = await http().get('/admin/policy/DATA_RETENTION_SCHEDULE').set(adminAuth).expect(200);
    expect(before.body.status).toBe('PROVISIONAL');

    const res = await http().patch('/admin/policy/DATA_RETENTION_SCHEDULE').set(adminAuth)
      .send({ value: { years: 7 } }).expect(200);
    expect(res.body.policy_value).toEqual({ years: 7 });
    expect(res.body.status).toBe('PROVISIONAL');
    expect(res.body.approved_by).toBeNull();
    expect(res.body.approved_at).toBeNull();
  });

  it('marking a policy APPROVED sets approved_by/approved_at exactly once', async () => {
    const approved = await http().patch('/admin/policy/PILOT_POPULATION_SCOPE').set(adminAuth)
      .send({ value: { county: 'Nairobi', scope: 'confirmed pilot' }, status: 'APPROVED' }).expect(200);
    expect(approved.body.status).toBe('APPROVED');
    expect(approved.body.approved_by).not.toBeNull();
    const firstApprovedAt = approved.body.approved_at;
    expect(firstApprovedAt).not.toBeNull();

    // A later value-only edit of an already-approved policy must not reset approved_at.
    const edited = await http().patch('/admin/policy/PILOT_POPULATION_SCOPE').set(adminAuth)
      .send({ value: { county: 'Nairobi', scope: 'confirmed pilot', note: 'tweaked wording' } }).expect(200);
    expect(edited.body.status).toBe('APPROVED');
    expect(edited.body.approved_at).toBe(firstApprovedAt);
  });

  it('rejects an invalid status value and a non-object value', async () => {
    await http().patch('/admin/policy/HOSTING_JURISDICTION').set(adminAuth).send({ status: 'DECIDED' }).expect(400);
    await http().patch('/admin/policy/HOSTING_JURISDICTION').set(adminAuth).send({ value: 'not-an-object' }).expect(400);
  });

  it('every update is recorded in the audit trail', async () => {
    const res = await pool.query(
      `SELECT action, previous_value, new_value FROM audit_events WHERE action = 'POLICY_UPDATED' ORDER BY created_at DESC LIMIT 1`,
    );
    expect(res.rows.length).toBe(1);
    expect(res.rows[0].new_value).toBeTruthy();
  });
});
