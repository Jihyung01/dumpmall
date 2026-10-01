import "server-only";
import { neon } from "@neondatabase/serverless";
import { aliasAdjectives, businessRegion } from "./business-region";

export async function saveBusinessProfile(userId: string, profile: {
  company: string; businessNumber: string; phone: string; businessAddress: string;
  payoutBank?: string; payoutAccount?: string; payoutHolder?: string;
}) {
  const area = businessRegion(profile.businessAddress);
  if (!area) throw new Error("Invalid business address");
  const sql = neon(process.env.DATABASE_URL!);
  // The user lock serializes profile changes; the counter UPSERT serializes
  // allocations in a district. Both locks last until the profile is committed.
  const results = await sql.transaction([
    sql.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`profile:${userId}`]),
    sql.query(`INSERT INTO alias_counters(district_key, next_slot)
      SELECT $2, 1 WHERE NOT EXISTS (
        SELECT 1 FROM profiles WHERE user_id=$1 AND district_key=$2 AND public_alias IS NOT NULL
      ) ON CONFLICT(district_key) DO UPDATE SET next_slot=alias_counters.next_slot+1`,
      [userId, area.districtKey]),
    sql.query(`INSERT INTO profiles(user_id, company, business_number, phone, region,
        business_address, district_key, public_alias, alias_version, payout_bank, payout_account, payout_holder, business_number_since)
      VALUES($1,$2,$3,$4,$5,$6,$7,
        COALESCE((SELECT public_alias FROM profiles WHERE user_id=$1 AND district_key=$7),
          (SELECT ($8::jsonb ->> ((next_slot-1)%20)) || ' ' || $7 ||
            CASE WHEN next_slot<=20 THEN '' ELSE ' ' || next_slot::text END
            FROM alias_counters WHERE district_key=$7)), 1, $9, $10, $11,
        to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
      ON CONFLICT(user_id) DO UPDATE SET company=excluded.company,
        business_number_since=CASE WHEN profiles.business_number IS DISTINCT FROM excluded.business_number
          THEN excluded.business_number_since ELSE profiles.business_number_since END,
        business_number=excluded.business_number, phone=excluded.phone,
        region=excluded.region, business_address=excluded.business_address,
        district_key=excluded.district_key, public_alias=excluded.public_alias,
        alias_version=excluded.alias_version, payout_bank=excluded.payout_bank,
        payout_account=excluded.payout_account, payout_holder=excluded.payout_holder
      RETURNING public_alias AS "publicAlias", district_key AS "districtKey"`,
      [userId, profile.company, profile.businessNumber, profile.phone, area.region,
        profile.businessAddress, area.districtKey, JSON.stringify(aliasAdjectives),
        profile.payoutBank || null, profile.payoutAccount || null, profile.payoutHolder || null]),
  ]);
  return results[2][0];
}
