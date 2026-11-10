# Moving the database from Render to Neon

Render's free Postgres is deleted 30 days after creation (around 2026-12-09). Neon's free tier
doesn't expire. Moving takes about 15 minutes and no code changes: the app only needs a different
`DATABASE_URL`, and its migrations create the schema automatically.

## 1. Create the Neon database
1. Sign up at https://neon.tech (GitHub sign-in is easiest).
2. Create a project: name `shaderlab`, Postgres 17 or 18, region **AWS US West (Oregon)**, which is the
   same region as the Render app, so queries stay fast.
3. On the project dashboard, open **Connect**, keep "Pooled connection" **off**, and copy the
   connection string. It looks like
   `postgresql://neondb_owner:...@ep-xxxx.us-west-2.aws.neon.tech/neondb?sslmode=require`.

## 2. Copy the data (in a terminal, from the `shaderlab` folder)
In Render: open **shaderlab-db**, then **Connect**, then copy the **External Database URL**.
```bash
export SRC_DATABASE_URL='<Render external URL>'
export DST_DATABASE_URL='<Neon connection string>'
./scripts/move-db.sh
```
It prints the number of shaders copied and the migrations recorded (should be `1,2,3`).

## 3. Point the app at Neon
In Render: **shaderlab** (the web service), then **Environment**. Edit `DATABASE_URL`, paste the Neon
connection string, and save. Render redeploys automatically (about 1 minute).

Then tell Claude, who will check the live site reads and writes through the new database.

## 4. Later
Once everything has worked for a few days, delete `shaderlab-db` on Render and remove the
`databases:` block and the `fromDatabase` reference from `render.yaml` (otherwise Render would
recreate it).
