export async function POST(request) {
  try {
    const body = await request.json();
    const { base64, mimeType } = body;

    const GEMINI_KEY = process.env.NEXT_PUBLIC_GEMINI_API_KEY;

    if (!GEMINI_KEY) {
      return Response.json({
        success: false,
        error: "GEMINI KEY MISSING - not found in environment",
        debug: { hasKey: false }
      }, { status: 500 });
    }

    const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_KEY}`;

    const geminiBody = {
      contents: [{
        parts: [
          { inline_data: { mime_type: mimeType || "image/jpeg", data: base64 || "" } },
          {
            text: `Analyze the provided pharmaceutical purchase invoice or challan.
Extract the data and return ONLY a valid JSON object matching the schema below.
Ensure all names, dates, quantities, rates, batch numbers, and tax calculations are precisely captured.
Do not wrap in markdown or block comments.

Schema:
{
  "supplierName": "Name of the supplier (e.g. ESHWARI PHARMA)",
  "invoiceNumber": "Challan No. or Invoice No. (e.g. CA000312)",
  "invoiceDate": "Invoice date in YYYY-MM-DD format (e.g. 2025-04-19)",
  "items": [{
    "genericName": "Generic name of medicine/formulation (e.g., LEVOCETIRIZINE)",
    "brandName": "Brand/Trade name in bold description (e.g., VOYCET-10 TAB)",
    "strength": "Medicine strength (e.g., '10mg', '650mg', '1%')",
    "form": "Form of medicine (e.g., 'Tablet', 'Syrup', 'Lotion', 'Diaper', 'Cream')",
    "batchNumber": "Batch No. from the invoice",
    "expiryDate": "Expiry Date parsed into standard YYYY-MM format (e.g. EXP 12/25 becomes 2025-12, 10/26 becomes 2026-10)",
    "mrp": 0.0, // Manufacturer printed MRP
    "sellingPrice": 0.0, // Suggested Retail Selling Price. Since it is Janaushadhi (generic), set this as 50% of the printed MRP (or equal to mrp if not generic)
    "purchasePrice": 0.0, // Unit purchase rate/price (labeled RATE on invoice)
    "quantity": 0, // Quantity (QTY)
    "unit": "Strip", // Strip, Bottle, Piece, Vial, or Tube
    "gstRate": "12", // 0, 5, 12, 18 or 28 based on invoice line details
    "barcode": null, // Barcode if visible, otherwise null
    "packSize": 1 // Integer pack size or conversion factor (default to 1. If description/packing details mention e.g. '1x12', '12s', 'Pack of 10', extract the number of units in the pack, e.g. 12 or 10)
  }]
}`
          }
        ]
      }],
      generationConfig: { temperature: 0.1, maxOutputTokens: 2048 }
    };

    const geminiResponse = await fetch(geminiUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(geminiBody)
    });

    const geminiData = await geminiResponse.json();

    if (!geminiResponse.ok || geminiData.error) {
      return Response.json({
        success: false,
        error: geminiData.error?.message || "Gemini API error",
        status: geminiResponse.status,
        geminiData: geminiData
      }, { status: 400 });
    }

    const text = geminiData.candidates?.[0]?.content?.parts?.[0]?.text || "";
    const clean = text.replace(/```json|```/g, "").trim();

    try {
      const parsed = JSON.parse(clean);
      return Response.json({ success: true, data: parsed });
    } catch {
      return Response.json({
        success: false,
        error: "JSON parse failed to compile clean string",
        rawText: text
      }, { status: 400 });
    }

  } catch (err) {
    return Response.json({
      success: false,
      error: err.message,
      stack: err.stack
    }, { status: 500 });
  }
}