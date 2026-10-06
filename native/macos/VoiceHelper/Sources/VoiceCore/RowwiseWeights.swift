import Foundation

/// The compact weight format the voice model is published in
/// ("omnivoice-rowwise"), as a specification this helper decodes.
///
/// A matrix is stored row by row in groups of `groupSize` values. Each group
/// has one scale; each value is a signed integer times that scale. At 4 bits,
/// two values share a byte — the first in the low half, the second in the
/// high half — each stored with 8 added, so 0…15 means −8…7.
public enum RowwiseWeights {
    public static let supportedBits = [4, 8]

    /// What a 4-bit value is stored with added to it.
    public static let nibbleOffset = 8

    /// Groups each row is split into.
    public static func groupCount(columns: Int, groupSize: Int) -> Int {
        (columns + groupSize - 1) / groupSize
    }

    /// Decodes one 4-bit matrix. The reference the tensor version is checked against.
    ///
    /// - Parameters:
    ///   - packed: `rows × groups × groupSize / 2` bytes.
    ///   - scales: `rows × groups` scales.
    /// - Returns: `rows × columns` values, row by row; the padding of the last group is dropped.
    public static func decode4Bit(
        packed: [UInt8], scales: [Float], rows: Int, columns: Int, groupSize: Int
    ) -> [Float] {
        let groups = groupCount(columns: columns, groupSize: groupSize)
        let bytesPerGroup = groupSize / 2
        precondition(packed.count == rows * groups * bytesPerGroup, "packed size does not match the shape")
        precondition(scales.count == rows * groups, "scales size does not match the shape")

        var values = [Float](repeating: 0, count: rows * columns)
        for row in 0..<rows {
            for group in 0..<groups {
                let scale = scales[row * groups + group]
                let base = (row * groups + group) * bytesPerGroup
                for index in 0..<groupSize {
                    let column = group * groupSize + index
                    guard column < columns else { break }
                    let byte = packed[base + index / 2]
                    let nibble = index % 2 == 0 ? byte & 0x0F : byte >> 4
                    values[row * columns + column] = Float(Int(nibble) - nibbleOffset) * scale
                }
            }
        }
        return values
    }
}
