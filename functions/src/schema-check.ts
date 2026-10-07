import { assertAppSchema } from './schema';

const names = assertAppSchema();
console.log(`EE Hub schema ok (${names.length} tables).`);
