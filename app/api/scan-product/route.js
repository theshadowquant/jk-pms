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
            text: `Analyze the provided pharmaceutical product packaging photo.
Extract the product details and return ONLY a valid JSON object matching the schema below.
If a field is not visible on the package, guess or estimate it based on standard product packaging where possible.
Do not wrap in markdown or block comments.

Schema:
{
  "genericName": "Generic name of medicine/formulation (e.g., Paracetamol, Levocetirizine, Luliconazole)",
  "brandName": "Brand/Trade name printed on the packaging (e.g., Calpol, Voycet-10, Luzic Lotion)",
  "strength": "Medicine strength (e.g., '10mg', '650mg', '1%', '500 mg')",
  "form": "Form of medicine (e.g., 'Tablet', 'Capsule', 'Syrup', 'Lotion', 'Cream', 'Ointment', 'Gel')",
  "batchNumber": "Batch No. if printed on the label, otherwise a generated short batch number",
  "expiryDate": "Expiry Date parsed into standard YYYY-MM format (e.g. EXP 12/25 becomes 2025-12, 10/26 becomes 2026-10)",
  "mrp": 0.0, // Manufacturer printed MRP if visible, otherwise 0.0
  "sellingPrice": 0.0, // Suggested retail selling price. Since it is Janaushadhi, set this to 50% of the MRP (or equal to mrp if not generic)
  "purchasePrice": 0.0, // Estimated purchase price (e.g., 30% of MRP, or 0.0)
  "unit": "Strip", // Default unit (e.g., Strip, Bottle, Tube, Vial, Piece)
  "gstRate": "12", // 0, 5, 12, 18 or 28 (typically 12 for medicines)
  "barcode": null // Barcode value if visible, otherwise null
}`
          }
        ]
      }],
      generationConfig: { temperature: 0.1, maxOutputTokens: 1024 }
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
