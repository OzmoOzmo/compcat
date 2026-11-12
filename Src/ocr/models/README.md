# Browser OCR models

These are the ONNX models and character dictionary supplied in
`Docs/comp_identifier-main/ocr/models`:

- `det_ppocrv3.onnx`: PaddleOCR PP-OCRv3 DB text detector.
- `rec_en_ppocrv5.onnx`: PaddleOCR PP-OCRv5 English recognizer.
- `dict_en_ppocrv5.txt`: recognizer character dictionary.

The supplied model notes identify these conversions as Apache-2.0 licensed:
the detector comes from RapidOCR's `rapidocr_onnxruntime` package and the
recognizer/dictionary come from `monkt/paddleocr-onnx`.

The source implementation and evaluation notes are in
`Docs/comp_identifier-main/ocr` and `Docs/comp_identifier-main/doc/text-recognition.md`.
