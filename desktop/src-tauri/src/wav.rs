// A minimal WAV writer for the Windows system-audio capture (ADR-0031).
//
// The macOS sidecar gets this for free from AVAudioFile; WASAPI hands us raw
// PCM frames and the file format is ours to write. Kept generic over
// `Write + Seek` so the whole thing is testable over an in-memory cursor —
// there is no audio endpoint on a CI runner, and a capture path that can only
// be tested by playing sound through a real device would never be tested.
use std::io::{Result as IoResult, Seek, SeekFrom, Write};

pub const WAVE_FORMAT_PCM: u16 = 1;
pub const WAVE_FORMAT_IEEE_FLOAT: u16 = 3;

pub const HEADER_LEN: u32 = 44;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct WavFmt {
    pub sample_rate: u32,
    pub channels: u16,
    pub bits_per_sample: u16,
    pub format_tag: u16,
}

impl WavFmt {
    pub fn block_align(&self) -> u16 {
        self.channels * (self.bits_per_sample / 8)
    }

    // The 44-byte canonical header. `data_len` is patched on finalize, so a
    // capture that is killed mid-flight still leaves a readable (if truncated)
    // file rather than a zero-length one.
    pub fn header(&self, data_len: u32) -> [u8; HEADER_LEN as usize] {
        let mut h = [0u8; HEADER_LEN as usize];
        let block_align = self.block_align() as u32;
        let byte_rate = self.sample_rate * block_align;
        h[0..4].copy_from_slice(b"RIFF");
        h[4..8].copy_from_slice(&(HEADER_LEN - 8 + data_len).to_le_bytes());
        h[8..12].copy_from_slice(b"WAVE");
        h[12..16].copy_from_slice(b"fmt ");
        h[16..20].copy_from_slice(&16u32.to_le_bytes());
        h[20..22].copy_from_slice(&self.format_tag.to_le_bytes());
        h[22..24].copy_from_slice(&self.channels.to_le_bytes());
        h[24..28].copy_from_slice(&self.sample_rate.to_le_bytes());
        h[28..32].copy_from_slice(&byte_rate.to_le_bytes());
        h[32..34].copy_from_slice(&(block_align as u16).to_le_bytes());
        h[34..36].copy_from_slice(&self.bits_per_sample.to_le_bytes());
        h[36..40].copy_from_slice(b"data");
        h[40..44].copy_from_slice(&data_len.to_le_bytes());
        h
    }
}

pub struct WavWriter<W: Write + Seek> {
    sink: W,
    fmt: WavFmt,
    data_len: u32,
}

impl<W: Write + Seek> WavWriter<W> {
    pub fn new(mut sink: W, fmt: WavFmt) -> IoResult<Self> {
        sink.write_all(&fmt.header(0))?;
        Ok(Self {
            sink,
            fmt,
            data_len: 0,
        })
    }

    pub fn write_frames(&mut self, bytes: &[u8]) -> IoResult<()> {
        self.sink.write_all(bytes)?;
        self.data_len += bytes.len() as u32;
        Ok(())
    }

    // Silence is written, not skipped: the capture loop uses this to keep the
    // file as long as wall time whenever the endpoint hands over fewer frames
    // than the clock says (see syscap_win.rs). A shorter file makes every later
    // word land early against the mic track.
    pub fn write_silence(&mut self, frames: u32) -> IoResult<()> {
        let block = self.fmt.block_align() as usize;
        let zeros = vec![0u8; block];
        for _ in 0..frames {
            self.sink.write_all(&zeros)?;
        }
        self.data_len += frames * block as u32;
        Ok(())
    }

    pub fn frames_written(&self) -> u32 {
        self.data_len
            .checked_div(self.fmt.block_align() as u32)
            .unwrap_or(0)
    }

    pub fn finalize(mut self) -> IoResult<W> {
        self.sink.seek(SeekFrom::Start(0))?;
        self.sink.write_all(&self.fmt.header(self.data_len))?;
        self.sink.flush()?;
        Ok(self.sink)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    fn f32_48k_stereo() -> WavFmt {
        WavFmt {
            sample_rate: 48_000,
            channels: 2,
            bits_per_sample: 32,
            format_tag: WAVE_FORMAT_IEEE_FLOAT,
        }
    }

    fn u32_at(buf: &[u8], off: usize) -> u32 {
        u32::from_le_bytes(buf[off..off + 4].try_into().unwrap())
    }

    #[test]
    fn header_is_the_canonical_44_bytes() {
        let h = f32_48k_stereo().header(0);
        assert_eq!(&h[0..4], b"RIFF");
        assert_eq!(&h[8..12], b"WAVE");
        assert_eq!(&h[12..16], b"fmt ");
        assert_eq!(&h[36..40], b"data");
        assert_eq!(
            u32_at(&h, 16),
            16,
            "fmt chunk is the 16-byte flavour ffmpeg always reads"
        );
        assert_eq!(
            u16::from_le_bytes(h[20..22].try_into().unwrap()),
            WAVE_FORMAT_IEEE_FLOAT
        );
        assert_eq!(u32_at(&h, 24), 48_000);
        assert_eq!(
            u32_at(&h, 28),
            48_000 * 8,
            "byte rate = rate * channels * bytes"
        );
        assert_eq!(
            u16::from_le_bytes(h[32..34].try_into().unwrap()),
            8,
            "block align"
        );
    }

    // The sizes are written twice: zero up front, real on finalize. A capture
    // whose header still says 0 plays as an empty file, which is how a "silent
    // meeting" would look to the user even with megabytes of audio on disk.
    #[test]
    fn finalize_patches_both_sizes() {
        let mut w = WavWriter::new(Cursor::new(Vec::new()), f32_48k_stereo()).unwrap();
        w.write_frames(&[0u8; 800]).unwrap();
        let buf = w.finalize().unwrap().into_inner();
        assert_eq!(buf.len(), 44 + 800);
        assert_eq!(u32_at(&buf, 40), 800, "data chunk size");
        assert_eq!(u32_at(&buf, 4), 36 + 800, "RIFF size = file - 8");
    }

    #[test]
    fn silence_occupies_real_frames() {
        let mut w = WavWriter::new(Cursor::new(Vec::new()), f32_48k_stereo()).unwrap();
        w.write_silence(100).unwrap();
        assert_eq!(w.frames_written(), 100);
        let buf = w.finalize().unwrap().into_inner();
        assert_eq!(u32_at(&buf, 40), 800, "100 frames * 8 bytes");
        assert!(buf[44..].iter().all(|b| *b == 0));
    }

    #[test]
    fn frames_written_counts_in_frames_not_bytes() {
        let mut w = WavWriter::new(Cursor::new(Vec::new()), f32_48k_stereo()).unwrap();
        w.write_frames(&[1u8; 80]).unwrap();
        assert_eq!(w.frames_written(), 10);
    }

    #[test]
    fn pcm16_mono_geometry() {
        let fmt = WavFmt {
            sample_rate: 16_000,
            channels: 1,
            bits_per_sample: 16,
            format_tag: WAVE_FORMAT_PCM,
        };
        assert_eq!(fmt.block_align(), 2);
        assert_eq!(u32_at(&fmt.header(0), 28), 32_000);
    }
}
