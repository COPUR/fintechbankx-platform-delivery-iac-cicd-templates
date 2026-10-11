// Creates or updates one service's MongoDB user (run by mongosh from
// 10-service-databases.sh, connected to the admin database without a login).
// Inputs from the environment only: MONGO_ROOT_USER / MONGO_ROOT_CRED (the
// root login of the mongo service) and FBX_DB / FBX_USER / FBX_CRED (the
// services.tsv row). The user lives in FBX_DB (its authentication database)
// and may read and write FBX_DB only.
const env = process.env;
for (const name of ["MONGO_ROOT_USER", "MONGO_ROOT_CRED", "FBX_DB", "FBX_USER", "FBX_CRED"]) {
  if (!env[name]) throw new Error(`[mongo-init] ${name} is not set`);
}
db.getSiblingDB("admin").auth(env.MONGO_ROOT_USER, env.MONGO_ROOT_CRED);
const target = db.getSiblingDB(env.FBX_DB);
const spec = { pwd: env.FBX_CRED, roles: [{ role: "readWrite", db: env.FBX_DB }] };
if (target.getUser(env.FBX_USER)) {
  target.updateUser(env.FBX_USER, spec);
  print(`[mongo-init] ${env.FBX_USER}@${env.FBX_DB}: credential and roles updated`);
} else {
  target.createUser({ user: env.FBX_USER, ...spec });
  print(`[mongo-init] ${env.FBX_USER}@${env.FBX_DB}: created`);
}
