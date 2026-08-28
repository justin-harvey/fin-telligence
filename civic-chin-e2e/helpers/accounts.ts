/**
 * Account registry — all credentials come from the environment (see .env.example).
 * Nothing is hardcoded here so the same specs run against any test tenant.
 */

export type Role =
  | 'civicAdmin'
  | 'muniAdmin'
  | 'muniEmployee'
  | 'acmeAdmin'
  | 'acmeEmployee'
  | 'tyrellAdmin'
  | 'tyrellEmployee';

export interface Account {
  role: Role;
  label: string;
  email: string;
  password: string;
  /** Where storageState is cached for this role, if it gets one. */
  storageState: string;
}

function req(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var ${name} (copy .env.example -> .env)`);
  return v;
}

export const ACCOUNTS: Record<Role, Account> = {
  civicAdmin: {
    role: 'civicAdmin',
    label: 'CivicChain admin',
    email: req('CIVIC_ADMIN_EMAIL'),
    password: req('CIVIC_ADMIN_PASSWORD'),
    storageState: '.auth/civicAdmin.json',
  },
  muniAdmin: {
    role: 'muniAdmin',
    label: 'Testville municipality admin',
    email: req('MUNI_ADMIN_EMAIL'),
    password: req('MUNI_ADMIN_PASSWORD'),
    storageState: '.auth/muniAdmin.json',
  },
  muniEmployee: {
    role: 'muniEmployee',
    label: 'Testville municipality employee',
    email: req('MUNI_EMPLOYEE_EMAIL'),
    password: req('MUNI_EMPLOYEE_PASSWORD'),
    storageState: '.auth/muniEmployee.json',
  },
  acmeAdmin: {
    role: 'acmeAdmin',
    label: 'Acme Inc. admin',
    email: req('ACME_ADMIN_EMAIL'),
    password: req('ACME_ADMIN_PASSWORD'),
    storageState: '.auth/acmeAdmin.json',
  },
  acmeEmployee: {
    role: 'acmeEmployee',
    label: 'Acme Inc. employee',
    email: req('ACME_EMPLOYEE_EMAIL'),
    password: req('ACME_EMPLOYEE_PASSWORD'),
    storageState: '.auth/acmeEmployee.json',
  },
  tyrellAdmin: {
    role: 'tyrellAdmin',
    label: 'Tyrell Corp. admin',
    email: req('TYRELL_ADMIN_EMAIL'),
    password: req('TYRELL_ADMIN_PASSWORD'),
    storageState: '.auth/tyrellAdmin.json',
  },
  tyrellEmployee: {
    role: 'tyrellEmployee',
    label: 'Tyrell Corp. employee',
    email: req('TYRELL_EMPLOYEE_EMAIL'),
    password: req('TYRELL_EMPLOYEE_PASSWORD'),
    storageState: '.auth/tyrellEmployee.json',
  },
};
