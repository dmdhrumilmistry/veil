import 'dart:io' show ZLibCodec;
import 'dart:typed_data';

/// deflate-raw, matching the web's CompressionStream('deflate-raw').
final _codec = ZLibCodec(raw: true, level: 6);

Uint8List deflateRaw(List<int> data) => Uint8List.fromList(_codec.encode(data));

Uint8List inflateRaw(List<int> data, {int limit = 32 * 1024}) {
  final out = _codec.decode(data);
  if (out.length > limit) throw const FormatException('payload too large');
  return Uint8List.fromList(out);
}
