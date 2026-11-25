export async function onRequest(context) {
  const { request, env } = context;
  const corsHeaders = {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  };

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  if (!env.DB) {
    return new Response(
      JSON.stringify({ ok: false, error: "D1 database binding 'DB' not found." }),
      { status: 500, headers: corsHeaders }
    );
  }

  const db = env.DB;

  async function ensureSchema() {
    await db.batch([
      db.prepare(
        "CREATE TABLE IF NOT EXISTS pos_inventory (id TEXT PRIMARY KEY, sort_order INTEGER DEFAULT 0, name TEXT NOT NULL, price REAL DEFAULT 0, stock INTEGER DEFAULT 0, is_patch_deal INTEGER DEFAULT 0, img TEXT DEFAULT '')"
      ),
      db.prepare(
        "CREATE TABLE IF NOT EXISTS pos_sales (uid TEXT PRIMARY KEY, order_id TEXT, timestamp TEXT, item_name TEXT, qty INTEGER DEFAULT 1, total REAL DEFAULT 0, payment_method TEXT DEFAULT '', seller TEXT DEFAULT '', buyer TEXT DEFAULT '', raw_json TEXT DEFAULT '{}', is_voided INTEGER DEFAULT 0)"
      ),
      db.prepare(
        "CREATE TABLE IF NOT EXISTS pos_settings (key TEXT PRIMARY KEY, value TEXT DEFAULT '')"
      )
    ]);
  }

  async function touchUpdated() {
    const now = String(Date.now());
    await db
      .prepare("INSERT OR REPLACE INTO pos_settings (key, value) VALUES ('__last_updated', ?)")
      .bind(now)
      .run();
    return now;
  }

  function isPinValid(providedPin) {
    const expected = String(env.ADMIN_PIN || "").trim();
    if (!expected) return false;
    const given = String(providedPin || "").trim();
    if (given.length !== expected.length) return false;
    let diff = 0;
    for (let i = 0; i < expected.length; i++) {
      diff |= expected.charCodeAt(i) ^ given.charCodeAt(i);
    }
    return diff === 0;
  }

  try {
    await ensureSchema();

    if (request.method === "GET") {
      const url = new URL(request.url);
      const since = url.searchParams.get("since") || "";

      const metaRow = await db
        .prepare("SELECT value FROM pos_settings WHERE key = '__last_updated'")
        .first();
      const lastUpdated = metaRow && metaRow.value ? String(metaRow.value) : "0";

      if (since && since === lastUpdated) {
        return new Response(
          JSON.stringify({ ok: true, unchanged: true, lastUpdated }),
          { status: 200, headers: corsHeaders }
        );
      }

      const invRes = await db
        .prepare("SELECT * FROM pos_inventory ORDER BY sort_order ASC, rowid ASC")
        .all();
      const salesRes = await db
        .prepare("SELECT * FROM pos_sales ORDER BY rowid ASC")
        .all();
      const setRes = await db
        .prepare("SELECT key, value FROM pos_settings WHERE key != '__last_updated'")
        .all();

      const inventory = (invRes.results || []).map((r) => ({
        id: r.id,
        name: r.name,
        price: Number(r.price) || 0,
        stock: Number(r.stock) || 0,
        isPatchDeal: Boolean(r.is_patch_deal),
        img: r.img || ""
      }));

      const sales = [];
      const voidedOrderIds = [];
      const seenVoided = new Set();

      for (const r of salesRes.results || []) {
        let parsed = {};
        try {
          parsed = r.raw_json ? JSON.parse(r.raw_json) : {};
        } catch (_) {}
        const entry = Object.assign({}, parsed, {
          uid: r.uid,
          orderId: r.order_id || parsed.orderId || "",
          timestamp: r.timestamp || parsed.timestamp || "",
          item: r.item_name || parsed.item || "",
          qty: Number(r.qty) || 0,
          total: Number(r.total) || 0,
          paymentMethod: r.payment_method || parsed.paymentMethod || parsed.payment || "",
          seller: r.seller || parsed.seller || "",
          buyer: r.buyer || parsed.buyer || "",
          isVoided: Boolean(r.is_voided)
        });
        if (r.is_voided) {
          if (entry.orderId && !seenVoided.has(entry.orderId)) {
            seenVoided.add(entry.orderId);
            voidedOrderIds.push(entry.orderId);
          }
        } else {
          sales.push(entry);
        }
      }

      const settings = {};
      for (const s of setRes.results || []) {
        try {
          settings[s.key] = JSON.parse(s.value);
        } catch (_) {
          settings[s.key] = s.value;
        }
      }

      return new Response(
        JSON.stringify({
          ok: true,
          status: "D1 Connected",
          pinConfigured: Boolean(env.ADMIN_PIN),
          lastUpdated,
          inventory,
          sales,
          voidedOrderIds,
          settings
        }),
        { status: 200, headers: corsHeaders }
      );
    }

    if (request.method === "POST") {
      const body = await request.json();
      const action = String(body.action || "");
      const headerPin = request.headers.get("X-Admin-Pin") || body.adminPin || "";

      if (action === "verifyPin") {
        return new Response(
          JSON.stringify({ ok: true, valid: isPinValid(headerPin) }),
          { status: 200, headers: corsHeaders }
        );
      }

      if (action === "recordSale") {
        const entries = Array.isArray(body.entries) ? body.entries : [];
        const stockAdjustments = Array.isArray(body.stockAdjustments) ? body.stockAdjustments : [];
        const stmts = [];

        for (const adj of stockAdjustments) {
          const delta = Number(adj.delta) || 0;
          if (delta !== 0) {
            stmts.push(
              db
                .prepare(
                  "UPDATE pos_inventory SET stock = MAX(0, stock + ?) WHERE id = ? OR LOWER(name) = LOWER(?)"
                )
                .bind(delta, String(adj.id || ""), String(adj.name || ""))
            );
          }
        }

        for (const e of entries) {
          const uid = String(
            e.uid || `${e.orderId || "ord"}_${e.item || "item"}_${e.timestamp || Date.now()}_${Math.random().toString(36).slice(2, 7)}`
          );
          stmts.push(
            db
              .prepare(
                "INSERT OR IGNORE INTO pos_sales (uid, order_id, timestamp, item_name, qty, total, payment_method, seller, buyer, raw_json, is_voided) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)"
              )
              .bind(
                uid,
                String(e.orderId || ""),
                String(e.timestamp || ""),
                String(e.item || ""),
                Number(e.qty) || 1,
                Number(e.total) || 0,
                String(e.paymentMethod || e.payment || ""),
                String(e.seller || ""),
                String(e.buyer || ""),
                JSON.stringify(e)
              )
          );
        }

        for (let i = 0; i < stmts.length; i += 50) {
          await db.batch(stmts.slice(i, i + 50));
        }
        const lastUpdated = await touchUpdated();
        return new Response(
          JSON.stringify({ ok: true, lastUpdated }),
          { status: 200, headers: corsHeaders }
        );
      }

      if (!isPinValid(headerPin)) {
        return new Response(
          JSON.stringify({ ok: false, error: "Invalid or missing Admin PIN." }),
          { status: 401, headers: corsHeaders }
        );
      }

      if (action === "saveInventory") {
        const items = Array.isArray(body.inventory) ? body.inventory : [];
        await db.prepare("DELETE FROM pos_inventory").run();
        const stmts = items.map((item, idx) =>
          db
            .prepare(
              "INSERT INTO pos_inventory (id, sort_order, name, price, stock, is_patch_deal, img) VALUES (?, ?, ?, ?, ?, ?, ?)"
            )
            .bind(
              String(item.id || `item_${idx}_${Date.now()}`),
              idx,
              String(item.name || "Unnamed Item"),
              Number(item.price) || 0,
              Number(item.stock) || 0,
              item.isPatchDeal ? 1 : 0,
              String(item.img || "")
            )
        );
        for (let i = 0; i < stmts.length; i += 50) {
          await db.batch(stmts.slice(i, i + 50));
        }
        const lastUpdated = await touchUpdated();
        return new Response(
          JSON.stringify({ ok: true, lastUpdated }),
          { status: 200, headers: corsHeaders }
        );
      }

      if (action === "saveSettings") {
        const settingsObj = body.settings && typeof body.settings === "object" ? body.settings : {};
        const stmts = Object.keys(settingsObj).map((k) =>
          db
            .prepare("INSERT OR REPLACE INTO pos_settings (key, value) VALUES (?, ?)")
            .bind(String(k), JSON.stringify(settingsObj[k]))
        );
        if (stmts.length > 0) {
          await db.batch(stmts);
        }
        const lastUpdated = await touchUpdated();
        return new Response(
          JSON.stringify({ ok: true, lastUpdated }),
          { status: 200, headers: corsHeaders }
        );
      }

      if (action === "voidOrder" || action === "editOrder") {
        const orderId = String(body.orderId || "");
        const restock = Array.isArray(body.restock) ? body.restock : [];
        const newEntries = Array.isArray(body.newEntries) ? body.newEntries : [];
        const stmts = [
          db.prepare("UPDATE pos_sales SET is_voided = 1 WHERE order_id = ?").bind(orderId)
        ];

        for (const r of restock) {
          stmts.push(
            db
              .prepare(
                "UPDATE pos_inventory SET stock = MAX(0, stock + ?) WHERE id = ? OR LOWER(name) = LOWER(?)"
              )
              .bind(Number(r.qty) || 0, String(r.id || ""), String(r.name || ""))
          );
        }

        for (const e of newEntries) {
          const uid = String(
            e.uid || `${e.orderId || "ord"}_${e.item || "item"}_${e.timestamp || Date.now()}_${Math.random().toString(36).slice(2, 7)}`
          );
          stmts.push(
            db
              .prepare(
                "INSERT OR IGNORE INTO pos_sales (uid, order_id, timestamp, item_name, qty, total, payment_method, seller, buyer, raw_json, is_voided) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)"
              )
              .bind(
                uid,
                String(e.orderId || ""),
                String(e.timestamp || ""),
                String(e.item || ""),
                Number(e.qty) || 1,
                Number(e.total) || 0,
                String(e.paymentMethod || e.payment || ""),
                String(e.seller || ""),
                String(e.buyer || ""),
                JSON.stringify(e)
              )
          );
        }

        for (let i = 0; i < stmts.length; i += 50) {
          await db.batch(stmts.slice(i, i + 50));
        }
        const lastUpdated = await touchUpdated();
        return new Response(
          JSON.stringify({ ok: true, lastUpdated }),
          { status: 200, headers: corsHeaders }
        );
      }

      if (action === "migrateFromLegacy") {
        const items = Array.isArray(body.inventory) ? body.inventory : [];
        const sales = Array.isArray(body.sales) ? body.sales : [];
        const voidedSet = new Set(Array.isArray(body.voidedOrderIds) ? body.voidedOrderIds : []);
        const settingsObj = body.settings && typeof body.settings === "object" ? body.settings : {};

        if (items.length > 0) {
          await db.prepare("DELETE FROM pos_inventory").run();
          const invStmts = items.map((item, idx) =>
            db
              .prepare(
                "INSERT INTO pos_inventory (id, sort_order, name, price, stock, is_patch_deal, img) VALUES (?, ?, ?, ?, ?, ?, ?)"
              )
              .bind(
                String(item.id || `item_${idx}`),
                idx,
                String(item.name || "Item"),
                Number(item.price) || 0,
                Number(item.stock) || 0,
                item.isPatchDeal ? 1 : 0,
                String(item.img || "")
              )
          );
          for (let i = 0; i < invStmts.length; i += 50) {
            await db.batch(invStmts.slice(i, i + 50));
          }
        }

        const saleStmts = sales.map((e, idx) => {
          const ordId = String(e.orderId || "");
          const uid = String(
            e.uid || `mig_${ordId}_${e.item || "item"}_${e.timestamp || idx}_${idx}`
          );
          const isVoid = voidedSet.has(ordId) || e.isVoided ? 1 : 0;
          return db
            .prepare(
              "INSERT OR REPLACE INTO pos_sales (uid, order_id, timestamp, item_name, qty, total, payment_method, seller, buyer, raw_json, is_voided) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
            )
            .bind(
              uid,
              ordId,
              String(e.timestamp || ""),
              String(e.item || ""),
              Number(e.qty) || 1,
              Number(e.total) || 0,
              String(e.paymentMethod || e.payment || ""),
              String(e.seller || ""),
              String(e.buyer || ""),
              JSON.stringify(e),
              isVoid
            );
        });
        for (let i = 0; i < saleStmts.length; i += 50) {
          await db.batch(saleStmts.slice(i, i + 50));
        }

        const setStmts = Object.keys(settingsObj).map((k) =>
          db
            .prepare("INSERT OR REPLACE INTO pos_settings (key, value) VALUES (?, ?)")
            .bind(String(k), JSON.stringify(settingsObj[k]))
        );
        if (setStmts.length > 0) {
          await db.batch(setStmts);
        }

        const lastUpdated = await touchUpdated();
        return new Response(
          JSON.stringify({
            ok: true,
            migratedInventory: items.length,
            migratedSales: sales.length,
            lastUpdated
          }),
          { status: 200, headers: corsHeaders }
        );
      }

      return new Response(
        JSON.stringify({ ok: false, error: `Unknown action: ${action}` }),
        { status: 400, headers: corsHeaders }
      );
    }

    return new Response(
      JSON.stringify({ ok: false, error: "Method not allowed" }),
      { status: 405, headers: corsHeaders }
    );
  } catch (err) {
    return new Response(
      JSON.stringify({ ok: false, error: String(err && err.message ? err.message : err) }),
      { status: 500, headers: corsHeaders }
    );
  }
}
