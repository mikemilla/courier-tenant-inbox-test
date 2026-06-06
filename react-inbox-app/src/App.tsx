import { useEffect, useState } from "react";
import { CourierInbox, useCourier } from "@trycourier/courier-react";

// Tenant-scoped Courier inbox rendered with <CourierInbox/>.
// A toggle re-auths `mike` with or without a tenant. tenantId is the only thing
// that changes: courier-react maps it to params.accountId on every inbox read,
// so WITH tenant the inbox is scoped to "sample-tenant"; WITHOUT it shows mike's
// whole inbox.
//
// The JWT is a hardcoded 365-day token for demo convenience. In production,
// mint JWTs on your backend and hand them to the client.

const cfg = {
  API_URL: "https://1m5q00wehc.execute-api.us-east-1.amazonaws.com/dev",
  INBOX_GRAPHQL: "https://hfyaspnct6.execute-api.us-east-1.amazonaws.com/dev/q",
};

const TENANT_ID = "sample-tenant";
const USER_ID = "mike";

// 365-day client JWT for `mike` (scopes: inbox read/write, brands, preferences),
// minted from the dev public key. Demo only — mint JWTs on your backend in prod.
const JWT =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzY29wZSI6InVzZXJfaWQ6bWlrZSBpbmJveDpyZWFkOm1lc3NhZ2VzIGluYm94OndyaXRlOmV2ZW50cyByZWFkOmJyYW5kcyByZWFkOnByZWZlcmVuY2VzIiwidGVuYW50X3Njb3BlIjoicHVibGlzaGVkL2Vudl8wMWt0Y3Z5ZWhiZXh5c2ZhNHJ0NjQzMWVyeSIsInRlbmFudF9pZCI6IjMwYTZjZDlkLWI4MmMtNDg3YS1hYmNhLTI5NjAzY2M1NjZhNi9lbnZfMDFrdGN2eWVoYmV4eXNmYTRydDY0MzFlcnkiLCJpYXQiOjE3ODA3MDQ3OTMsImV4cCI6MTgxMjI0MDc5MywianRpIjoiZmFiZDE4ODctYmZhZC00YWI0LWE1MGMtZDVjMmNlMjgzMWUwIn0.g5DL9fAkG2-nhAyYrO_a6KhkPUCCn7IWyZc-GKlbizo";

const apiUrls = {
  courier: { rest: cfg.API_URL, graphql: `${cfg.API_URL}/client/q` },
  inbox: { graphql: cfg.INBOX_GRAPHQL, webSocket: "wss://realtime.courier.io" },
};

export default function App() {
  const courier = useCourier();
  const [withTenant, setWithTenant] = useState(true);

  // Re-auth whenever the tenant toggle flips. tenantId is the only knob changing.
  useEffect(() => {
    courier.auth.signIn({
      userId: USER_ID,
      jwt: JWT,
      tenantId: withTenant ? TENANT_ID : undefined,
      apiUrls,
    });
    return () => courier.auth.signOut();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [withTenant]);

  return (
    <div style={{ maxWidth: 600, margin: "40px auto", fontFamily: "system-ui, sans-serif" }}>
      <h1>Courier tenant inbox</h1>
      <p style={{ color: "#555" }}>
        user=<b>{USER_ID}</b> · auth=<b>JWT</b> · tenant=
        <b>{withTenant ? TENANT_ID : "none"}</b>
      </p>

      <label style={{ display: "block", marginBottom: 12 }}>
        <input
          type="checkbox"
          checked={withTenant}
          onChange={(e) => setWithTenant(e.target.checked)}
        />{" "}
        Authenticate with tenant (tenantId → accountId)
      </label>

      <div style={{ height: 600, border: "1px solid #ddd", borderRadius: 8, overflow: "hidden" }}>
        {/* Re-mount the inbox on scope change so it re-reads with the new auth. */}
        <CourierInbox key={withTenant ? "tenant" : "no-tenant"} />
      </div>
    </div>
  );
}
