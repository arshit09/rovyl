//! The three typefaces the product draws with, and the private collection DirectWrite reads them
//! from.
//!
//! **Why they are bundled.** The original is a browser and asks for "Inter Variable" and "Space
//! Grotesk Variable" by name, having shipped the files beside the page. Asking Windows for those
//! families by name finds them on a machine where somebody happens to have installed them and
//! finds nothing on everyone else's — and a missing family is not an error anywhere, it is a
//! silent substitution. The substitute has different metrics, so the wheel's pills come out a
//! different width and the settings rows a different height. The faces are embedded in the
//! executable instead, so a fresh install draws what the design was drawn against.
//!
//! **Why a private collection and not an install.** Registering a font with Windows is a
//! machine-wide change that wants an installer and leaves something behind at uninstall.
//! `IDWriteInMemoryFontFileLoader` hands DirectWrite the bytes for the life of this process and
//! touches nothing outside it.
//!
//! Each file is the upstream variable font with its name table normalised to one family name —
//! Space Grotesk ships as "Space Grotesk Light" with a typographic-family override, which would
//! file it under the wrong name here. All three are under the SIL Open Font License; the licence
//! text sits beside each file in `assets/fonts`.

use windows::core::Interface;
use windows::Win32::Graphics::DirectWrite::{
    IDWriteFactory3, IDWriteFactory5, IDWriteFontCollection1, IDWriteInMemoryFontFileLoader,
};

/// Settings, menus, everything in a window. Weights 100–900, and the only one of the three with
/// Cyrillic and Greek — which is what the Russian panel is set in.
pub const INTER: &[u8] = include_bytes!("../../assets/fonts/Inter.ttf");
/// Headings and the wordmark. Weights 300–700.
pub const SPACE_GROTESK: &[u8] = include_bytes!("../../assets/fonts/SpaceGrotesk.ttf");
/// The wheel. Weights 400–700.
pub const INSTRUMENT_SANS: &[u8] = include_bytes!("../../assets/fonts/InstrumentSans.ttf");

/// The collection, and the loader that has to outlive it.
///
/// The loader is held rather than dropped on purpose: it is registered with the factory and owns
/// the mapping from the font-file references in the collection back to the bytes above. Drop it
/// and every layout built from the collection draws nothing.
pub struct Bundled {
    pub collection: IDWriteFontCollection1,
    _loader: IDWriteInMemoryFontFileLoader,
}

/// Build the collection, or `None` on a platform that cannot.
///
/// Every step is fallible and none of them is worth failing the process over: without a
/// collection the product falls back to the system faces named in `text::Family::candidates`,
/// which is how it looked before the faces were bundled.
pub fn load(factory: &IDWriteFactory3) -> Option<Bundled> {
    unsafe {
        let factory5: IDWriteFactory5 = factory.cast().ok()?;
        let loader = factory5.CreateInMemoryFontFileLoader().ok()?;
        // Registered BEFORE the references are handed to the set builder: an unregistered loader
        // produces file references the builder cannot resolve, and it reports that as a plain
        // E_INVALIDARG from `AddFontFile` with nothing to say which file.
        factory5.RegisterFontFileLoader(&loader).ok()?;

        let builder = factory5.CreateFontSetBuilder().ok()?;
        for bytes in [INTER, SPACE_GROTESK, INSTRUMENT_SANS] {
            // `None` for the owner, so DirectWrite takes its own copy. These are `'static` and a
            // copy is not needed, but the alternative is an object whose lifetime has to outlive
            // every layout and there is nothing to gain by proving that.
            let file = loader
                .CreateInMemoryFontFileReference(
                    &factory5,
                    bytes.as_ptr() as *const _,
                    bytes.len() as u32,
                    None,
                )
                .ok()?;
            // A variable font goes in as a resource, so the set carries every named instance —
            // Regular, Medium, SemiBold — rather than only the default one.
            builder.AddFontFile(&file).ok()?;
        }
        let set = builder.CreateFontSet().ok()?;
        let collection = factory5.CreateFontCollectionFromFontSet(&set).ok()?;
        Some(Bundled {
            collection,
            _loader: loader,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_face_is_embedded_and_is_a_truetype_file() {
        // `include_bytes!` of a path that does not exist is a build error, so the files being
        // here is already proven. What this checks is that they are fonts and not, say, a Git LFS
        // pointer that was committed in their place — which is a file of a few hundred bytes that
        // DirectWrite rejects at `AddFontFile`, three layers from anything that names the cause.
        for (name, bytes) in [
            ("Inter", INTER),
            ("Space Grotesk", SPACE_GROTESK),
            ("Instrument Sans", INSTRUMENT_SANS),
        ] {
            assert!(bytes.len() > 20_000, "{name} is too small to be a font");
            // The sfnt version of a TrueType outline file. An OpenType/CFF one would start with
            // `OTTO`, which DirectWrite also takes — these three are all glyf-flavoured.
            assert_eq!(&bytes[..4], &[0x00, 0x01, 0x00, 0x00], "{name} is not a TrueType file");
        }
    }
}
