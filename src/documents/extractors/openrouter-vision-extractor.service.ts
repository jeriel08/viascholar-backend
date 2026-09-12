import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { pdf } from 'pdf-to-img';
import { PDFDocument, PDFName, PDFRawStream } from 'pdf-lib';
import {
  ExtractedResult,
  IDocumentExtractor,
  InputDocumentFile,
} from './document-extractor.interface.js';

@Injectable()
export class OpenRouterVisionExtractorService implements IDocumentExtractor {
  private readonly logger = new Logger(OpenRouterVisionExtractorService.name);

  constructor(private configService: ConfigService) {}

  private async extractImagesFromPdf(
    pdfBuffer: Buffer,
  ): Promise<Array<{ buffer: Buffer; mimeType: string }>> {
    const images: Array<{ buffer: Buffer; mimeType: string }> = [];
    try {
      const pdfDoc = await PDFDocument.load(pdfBuffer, { ignoreEncryption: true });
      const pages = pdfDoc.getPages();

      for (const page of pages) {
        const { node } = page as any;
        const resources = node?.Resources ? node.Resources() : null;
        if (!resources) continue;
        const xObjects = resources.get(PDFName.of('XObject'));
        if (!xObjects) continue;

        const xObjectDict = pdfDoc.context.lookup(xObjects) as any;
        if (!xObjectDict || !xObjectDict.dict) continue;

        for (const [, value] of xObjectDict.dict.entries()) {
          const stream = pdfDoc.context.lookup(value) as PDFRawStream;
          if (!stream || !stream.dict) continue;

          const subtype = stream.dict.get(PDFName.of('Subtype'));
          if (subtype === PDFName.of('Image')) {
            const filter = stream.dict.get(PDFName.of('Filter'));
            const filterName = filter ? filter.toString() : '';

            let mimeType = 'image/jpeg';
            if (filterName.includes('FlateDecode')) {
              mimeType = 'image/png';
            }

            const imageBytes = stream.contents;
            if (imageBytes && imageBytes.length > 5000) {
              images.push({
                buffer: Buffer.from(imageBytes),
                mimeType,
              });
            }
          }
        }
      }
    } catch (err: any) {
      this.logger.debug(`PDF raw image stream extraction skipped: ${err.message}`);
    }
    return images;
  }

  private async prepareImageContentItems(
    input: InputDocumentFile | InputDocumentFile[],
  ): Promise<{ imageContentItems: Array<{ type: string; image_url: { url: string } }>; firstFileName: string }> {
    const files = Array.isArray(input) ? input : [input];
    const imageContentItems: Array<{
      type: string;
      image_url: { url: string };
    }> = [];

    for (const f of files) {
      const mime = (f.mimeType || '').toLowerCase();
      const name = (f.fileName || '').toLowerCase();
      const isPdf = mime.includes('pdf') || name.endsWith('.pdf');

      if (isPdf) {
        const extractedPdfImages = await this.extractImagesFromPdf(f.buffer);

        if (extractedPdfImages.length > 0) {
          this.logger.log(
            `Extracted ${extractedPdfImages.length} embedded image stream(s) directly from PDF '${f.fileName || 'document.pdf'}'.`,
          );
          for (const img of extractedPdfImages.slice(0, 8)) {
            imageContentItems.push({
              type: 'image_url',
              image_url: {
                url: `data:${img.mimeType};base64,${img.buffer.toString('base64')}`,
              },
            });
          }
        } else {
          try {
            this.logger.log(
              `Rendering PDF '${f.fileName || 'document.pdf'}' pages via pdf-to-img...`,
            );
            const pdfDoc = await pdf(f.buffer, { scale: 2 });
            let pageCount = 0;
            for await (const pageBuffer of pdfDoc) {
              if (pageCount >= 8) break;
              imageContentItems.push({
                type: 'image_url',
                image_url: {
                  url: `data:image/png;base64,${pageBuffer.toString('base64')}`,
                },
              });
              pageCount++;
            }
          } catch (pdfErr: any) {
            this.logger.error(
              `PDF image conversion fallback failed: ${pdfErr.message}.`,
            );
          }
        }
      } else {
        const effectiveMime = mime || 'image/jpeg';
        imageContentItems.push({
          type: 'image_url',
          image_url: {
            url: `data:${effectiveMime};base64,${f.buffer.toString('base64')}`,
          },
        });
      }
    }

    const firstFileName = files[0]?.fileName || 'document';
    return { imageContentItems, firstFileName };
  }

  async extractData(
    input: InputDocumentFile | InputDocumentFile[],
    documentType: string,
  ): Promise<ExtractedResult> {
    const apiKey = this.configService.get<string>('OPENROUTER_API_KEY');
    const model =
      this.configService.get<string>('OPENROUTER_MODEL') ||
      'inclusionai/ling-3.0-flash-vl:free';

    if (!apiKey) {
      throw new Error(
        'OPENROUTER_API_KEY is not configured in environment variables.',
      );
    }

    const { imageContentItems, firstFileName } = await this.prepareImageContentItems(input);

    this.logger.log(
      `Dispatching ${imageContentItems.length} raw image page(s) ('${firstFileName}') (${documentType}) to OpenRouter Vision LLM model '${model}'...`,
    );

    const systemPrompt = `You are an expert document OCR and structured data extraction AI specializing in Philippine academic documents (Form 138 / Report Card, Transcript of Records - TOR, Statement of Account, Certified Copy of Grades - COG).
Your task is to analyze the attached document image/PDF (${documentType}) and extract structured JSON data adhering strictly to the JSON schema below.

JSON Schema & Fields:
- "student_name" (string): Student's full name from the document. Format as 'LAST NAME, FIRST NAME MIDDLE NAME' or 'FIRST NAME LAST NAME'.
- "school_name" (string): Name of the college, university, or high school issuing the document.
- "course_name" (string): Degree program or course of study (e.g., "BS Information Technology", "Grade 12 STEM").
- "grade_level" (string): High school grade level or college year level (e.g., "Grade 12", "Grade 7", "1st Year").
- "section" (string): Class section or stream identifier if present (e.g., "7-Lanzones", "12-STEM 1", "Lanzones").
- "has_signature" (boolean): Set to true if a registrar signature, authorized signature line, or official school seal/stamp is visible; otherwise false.
- "general_average" (number or null): The overall 'General Average' or 'GWA' printed at the bottom of the document or grade table. Null if unavailable.
- "academic_year" (string): School year / Academic year (e.g., "2024-2025"). Remove prefixes like 'A.Y.', 'AY', 'S.Y.', 'SY'.
- "semester" (string): Main semester/cycle (e.g., "1st Semester", "2nd Semester", "Summer", "1st Trimester"). Return "Annual" for high school Form 138 unless explicitly separated.
- "term" (string): Specific sub-term or period within semester if stated (e.g., "1st Term", "2nd Term"). Default to "Full Semester" if not specified.
- "first_sem_average" (number or null): General average for First Semester at footer of 1st Semester table.
- "second_sem_average" (number or null): General average for Second Semester at footer of 2nd Semester table.
- "grades" (array of objects): List of subjects. Each item MUST have:
    - "subject_code" (string): Course code or subject identifier (e.g., "NSTP 1", "PAHF 1", "GE 2").
    - "subject_name" (string): Descriptive title of the subject.
    - "units" (number): Credit units/hours. Default to 0.0 if not listed.
    - "grade" (number): Final grade or rating earned. If final grade is blank, extract latest quarter grade.
    - "semester" (string): "1st Semester" or "2nd Semester" based on table column or header.

STRICT INSTRUCTIONS:
1. Return ONLY valid, raw JSON. Do not include markdown code block formatting (like \`\`\`json), commentary, or extra text.
2. Ensure numeric values for grades, units, and averages are numbers (e.g., 1.75, 88.5), not stringified numbers.
3. If a field is not found or not applicable, set it to null.`;

    const requestBody = {
      model,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: systemPrompt,
            },
            ...imageContentItems,
          ],
        },
      ],
      temperature: 0.1,
    };

    const startTime = Date.now();
    const response = await fetch(
      'https://openrouter.ai/api/v1/chat/completions',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'https://viascholar.edu',
          'X-Title': 'ViaScholar Document OCR',
        },
        body: JSON.stringify(requestBody),
      },
    );

    const elapsedMs = Date.now() - startTime;

    if (!response.ok) {
      const errorText = await response.text();
      this.logger.error(
        `OpenRouter API returned status ${response.status} after ${elapsedMs}ms: ${errorText}`,
      );
      throw new Error(
        `OpenRouter API extraction failed (${response.status}): ${errorText}`,
      );
    }

    const responseData = (await response.json()) as {
      choices?: Array<{
        message?: {
          content?: string;
        };
      }>;
    };

    const content = responseData.choices?.[0]?.message?.content;
    if (!content) {
      throw new Error('OpenRouter API returned empty message content.');
    }

    this.logger.log(
      `OpenRouter Vision LLM responded in ${elapsedMs}ms for '${firstFileName}'.`,
    );

    let cleanedJsonString = content
      .replace(/^```(?:json)?\s*/gi, '')
      .replace(/\s*```$/gi, '')
      .trim();

    const jsonMatch = cleanedJsonString.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      cleanedJsonString = jsonMatch[0];
    }

    try {
      const parsedData = JSON.parse(cleanedJsonString) as ExtractedResult;
      return parsedData;
    } catch (parseError: any) {
      this.logger.error(
        `Failed to parse OpenRouter JSON output: ${parseError.message}. Raw output snippet: ${cleanedJsonString.slice(0, 300)}`,
      );
      throw new Error(
        `OpenRouter response could not be parsed as valid JSON: ${parseError.message}`,
      );
    }
  }

  async extractProspectusData(
    input: InputDocumentFile | InputDocumentFile[],
  ): Promise<{
    course_name?: string;
    course_code?: string;
    curriculum_year?: string;
    total_units?: number;
    subjects: Array<{
      subject_code: string;
      descriptive_title: string;
      units: number;
      year_level: number;
      semester: string;
      prerequisites?: string[];
    }>;
  }> {
    const apiKey = this.configService.get<string>('OPENROUTER_API_KEY');
    const model =
      this.configService.get<string>('OPENROUTER_MODEL') ||
      'inclusionai/ling-3.0-flash-vl:free';

    if (!apiKey) {
      throw new Error(
        'OPENROUTER_API_KEY is not configured in environment variables.',
      );
    }

    const { imageContentItems, firstFileName } = await this.prepareImageContentItems(input);

    this.logger.log(
      `Dispatching ${imageContentItems.length} prospectus page(s) ('${firstFileName}') to OpenRouter Vision LLM model '${model}'...`,
    );

    const systemPrompt = `You are an expert academic curriculum OCR and structured extraction AI specializing in Philippine college and university curriculum evaluation sheets, program checklists, and prospectuses.
Your task is to analyze the attached prospectus / curriculum checklist document and extract all curriculum metadata and subjects organized by Year Level and Semester.

Strict JSON schema:
{
  "course_name": string (e.g. "Bachelor of Science in Information Technology", "BS Computer Science"),
  "course_code": string (e.g. "BSIT", "BSCS", "BSIS") or null,
  "curriculum_year": string (e.g. "2023-2024", "2024-2025", "Effective SY 2021-2022") or null,
  "total_units": number (total units across all years) or null,
  "subjects": [
    {
      "subject_code": string (e.g. "IT 101", "CCE 102", "GE 2", "NSTP 1"),
      "descriptive_title": string (e.g. "Introduction to Computing", "Computer Programming 1"),
      "units": number (e.g. 3.0, 2.0, 1.0, 6.0),
      "year_level": number (1 for First Year, 2 for Second Year, 3 for Third Year, 4 for Fourth Year),
      "semester": string ("1st Semester", "2nd Semester", or "Summer"),
      "prerequisites": array of strings (e.g. ["CCE 101"] or empty array [])
    }
  ]
}

STRICT INSTRUCTIONS:
1. Extract ALL subjects in the curriculum from 1st Year to 4th Year (or all listed year levels).
2. For each subject, ensure "subject_code" is clean (e.g. "CCE 102").
3. Ensure "year_level" is an integer (1, 2, 3, or 4).
4. Ensure "semester" is one of "1st Semester", "2nd Semester", or "Summer".
5. Ensure "units" is a valid number. If lab and lec units are listed separately, sum them (e.g., 2 lec + 1 lab = 3.0).
6. Return ONLY valid, raw JSON. Do not include markdown code block formatting, commentary, or extra text.`;

    const requestBody = {
      model,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: systemPrompt,
            },
            ...imageContentItems,
          ],
        },
      ],
      temperature: 0.1,
    };

    const startTime = Date.now();
    const response = await fetch(
      'https://openrouter.ai/api/v1/chat/completions',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'https://viascholar.edu',
          'X-Title': 'ViaScholar Prospectus OCR',
        },
        body: JSON.stringify(requestBody),
      },
    );

    const elapsedMs = Date.now() - startTime;

    if (!response.ok) {
      const errorText = await response.text();
      this.logger.error(
        `OpenRouter API returned status ${response.status} after ${elapsedMs}ms: ${errorText}`,
      );
      throw new Error(
        `OpenRouter API extraction failed (${response.status}): ${errorText}`,
      );
    }

    const responseData = (await response.json()) as {
      choices?: Array<{
        message?: {
          content?: string;
        };
      }>;
    };

    const content = responseData.choices?.[0]?.message?.content;
    if (!content) {
      throw new Error('OpenRouter API returned empty message content.');
    }

    let cleanedJsonString = content
      .replace(/^```(?:json)?\s*/gi, '')
      .replace(/\s*```$/gi, '')
      .trim();

    const jsonMatch = cleanedJsonString.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      cleanedJsonString = jsonMatch[0];
    }

    try {
      const parsedData = JSON.parse(cleanedJsonString);
      return {
        course_name: parsedData.course_name,
        course_code: parsedData.course_code,
        curriculum_year: parsedData.curriculum_year,
        total_units: parsedData.total_units,
        subjects: Array.isArray(parsedData.subjects) ? parsedData.subjects : [],
      };
    } catch (parseError: any) {
      this.logger.error(
        `Failed to parse Prospectus OCR JSON output: ${parseError.message}. Raw: ${cleanedJsonString.slice(0, 300)}`,
      );
      throw new Error(
        `Prospectus OCR response could not be parsed as valid JSON: ${parseError.message}`,
      );
    }
  }
}
