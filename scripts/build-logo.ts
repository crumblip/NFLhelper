import sharp from 'sharp';
import { existsSync, mkdirSync } from 'node:fs';

/**
 * Turns the ChipShip logo into the assets the app actually needs.
 *
 * The source is a wide lockup on a white field: the chip-and-runner mark on top,
 * "CHIP SHIP / FANTASY FOOTBALL ANALYTICS" beneath. Neither of those things can
 * be dropped into the rail as-is.
 *
 * TWO PROBLEMS, and the second is the one that matters.
 *
 * 1. **The white field.** The rail is dark in both themes on purpose, so a white
 *    rectangle behind the mark would be the single brightest thing on the page.
 *    Every pixel above the threshold below becomes transparent.
 *
 * 2. **The wordmark cannot come.** The rail slot is about 44 pixels across. A
 *    lockup whose text is already small at 1024px wide renders as illegible
 *    grey mush at that size, and "make the logo smaller" is how a good mark gets
 *    turned into a smudge. So the rail gets the MARK ALONE, cropped from the
 *    top, and the name is set in type beside it where type belongs.
 *
 * The full lockup is still emitted, at a size where its text is readable, for
 * anywhere with room for it.
 *
 * Run: `npm run build:logo` after saving the source to `assets/chipship.png`.
 */

const SOURCE = process.argv[2] ?? 'assets/chipship.png';
const OUT = 'public';

/**
 * How close to white counts as background.
 *
 * 236 rather than 250 because the source is a rendered PNG with slight
 * compression noise in the field, and a tighter threshold leaves a dirty grey
 * fringe that only shows up once the mark is on a dark ground — which is the
 * one place it is going.
 */
const WHITE = 236;

async function main(): Promise<void> {
  if (!existsSync(SOURCE)) {
    console.error(`No source image at ${SOURCE}.`);
    console.error('Save the logo there (or pass a path) and run this again.');
    process.exitCode = 1;
    return;
  }
  mkdirSync(OUT, { recursive: true });

  const img = sharp(SOURCE).ensureAlpha();
  const meta = await img.metadata();
  const W = meta.width ?? 0;
  const H = meta.height ?? 0;
  if (!W || !H) {
    console.error('Could not read the image dimensions.');
    process.exitCode = 1;
    return;
  }
  console.log(`source ${W}x${H}`);

  /**
   * Knocks the white field out to transparency.
   *
   * Done on raw pixels rather than with a chroma key because the mark contains
   * near-white of its own — the helmet stripe, the ball laces, the cream ring
   * around the chip. Those survive because this only clears a pixel when ALL
   * THREE channels are above the threshold, which the mark's creams are not:
   * they carry a warm cast, so their blue channel sits well below their red.
   */
  const clearWhite = async (input: sharp.Sharp): Promise<Buffer> => {
    const { data, info } = await input.raw().toBuffer({ resolveWithObject: true });

    /*
     * A source that is ALREADY transparent is left alone.
     *
     * The logo arrived having been through a background remover, so its field
     * was gone before this script saw it — and running the knockout anyway
     * would have eaten the chip's own white segments, which ARE pure white and
     * are the most recognisable thing in the mark. Detected rather than
     * configured, because the flag would eventually be set wrong.
     */
    let clear = 0;
    for (let i = 3; i < data.length; i += info.channels) if (data[i]! === 0) clear++;
    const alreadyCut = clear / (data.length / info.channels) > 0.05;
    if (alreadyCut) {
      console.log('  source is already transparent, leaving the alpha alone');
      return input.png().toBuffer();
    }

    const px = Buffer.from(data);
    for (let i = 0; i < px.length; i += info.channels) {
      if (px[i]! >= WHITE && px[i + 1]! >= WHITE && px[i + 2]! >= WHITE) {
        px[i + 3] = 0;
      }
    }
    return sharp(px, { raw: { width: info.width, height: info.height, channels: 4 } })
      .png()
      .toBuffer();
  };

  /* ---- the mark alone, for the rail ---- */

  /*
   * The mark occupies the upper portion of the lockup. Cropping generously and
   * then TRIMMING is deliberate: a hand-measured box would be wrong the moment
   * the source is re-exported at another size, whereas trim finds the real
   * bounds of whatever survived the background removal.
   */
  /*
   * The mark's box is MEASURED from the alpha channel, not guessed at.
   *
   * A fraction of the height was tried first and produced a bad crop twice: it
   * clipped the bottom of the chip while simultaneously catching the tips of
   * the laurel wreaths that flank the wordmark. Both failures come from the
   * same thing — the wordmark's decoration reaches UP the sides while the chip
   * narrows going DOWN, so no single horizontal line separates them.
   *
   * Two measurements do:
   *
   *  - the BOTTOM is where opaque pixels per row jump. Through the chip the
   *    figure sits at 20-30% of the width and the moment the banner starts it
   *    steps to 36-41%. On this source that lands at y=392 of 559.
   *  - the SIDES come from keeping, on every row, only the run of opaque pixels
   *    that contains the image's centre. The laurels are separate runs out at
   *    the edges, so they drop out on their own — at y=385 the row holds
   *    323-373, 422-596 and 651-701, and only the middle one is the chip.
   *
   * Measured rather than hardcoded so a re-export at another size still works.
   */
  const { data: aData, info: aInfo } = await sharp(SOURCE)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const opaque = (x: number, y: number) => aData[(y * W + x) * aInfo.channels + 3]! > 24;

  const density: number[] = [];
  for (let y = 0; y < H; y++) {
    let n = 0;
    for (let x = 0; x < W; x++) if (opaque(x, y)) n++;
    density.push(n);
  }

  const firstRow = density.findIndex((n) => n > 0);

  /*
   * The banner edge is the LARGEST STEP in row density, not the first row over
   * a threshold.
   *
   * A threshold was tried and cut the mark in half: the chip's own widest rows
   * are denser than the player's above them, so any level set from the whole
   * mark is crossed by the chip itself long before the banner. The step is
   * unambiguous where a level is not — through the chip the count drifts
   * between 250 and 300, and at the banner it goes 276 to 365 in six rows,
   * which is far larger than any change inside the artwork.
   */
  const STEP = 8;
  let markBottom = H;
  let biggest = 0;
  for (let y = Math.round(H * 0.45); y < Math.round(H * 0.9); y++) {
    const jump = density[y]! - density[y - STEP]!;
    if (jump > biggest) {
      biggest = jump;
      // Back off past the step so the banner's own top edge does not survive.
      markBottom = Math.max(firstRow + 1, y - STEP - 2);
    }
  }

  const centre = Math.round(W / 2);
  let left = W;
  let right = 0;
  for (let y = firstRow; y < markBottom; y++) {
    let s = -1;
    for (let x = 0; x <= W; x++) {
      const on = x < W && opaque(x, y);
      if (on && s < 0) s = x;
      if (!on && s >= 0) {
        if (s <= centre && x > centre) {
          if (s < left) left = s;
          if (x - 1 > right) right = x - 1;
        }
        s = -1;
      }
    }
  }
  console.log(
    `mark box: x ${left}..${right}, y ${firstRow}..${markBottom} ` +
      `(banner edge found as the largest density step, +${biggest} px)`,
  );

  const markBuf = await clearWhite(
    sharp(SOURCE).ensureAlpha().extract({
      left,
      top: firstRow,
      width: right - left + 1,
      height: markBottom - firstRow,
    }),
  );

  const mark = await sharp(markBuf).trim({ threshold: 1 }).toBuffer({ resolveWithObject: true });
  console.log(`mark trimmed to ${mark.info.width}x${mark.info.height}`);

  // 128px covers a 44px rail slot at 2x and a 64px header at 2x.
  await sharp(mark.data)
    .resize({ height: 128, fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png({ compressionLevel: 9 })
    .toFile(`${OUT}/chipship-mark.png`);

  await sharp(mark.data)
    .resize({ height: 512, fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png({ compressionLevel: 9 })
    .toFile(`${OUT}/chipship-mark-512.png`);

  /* ---- the full lockup, transparent ---- */

  const fullBuf = await clearWhite(sharp(SOURCE).ensureAlpha());
  const full = await sharp(fullBuf).trim({ threshold: 1 }).toBuffer();
  await sharp(full)
    .resize({ width: 640, fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png({ compressionLevel: 9 })
    .toFile(`${OUT}/chipship-lockup.png`);

  /* ---- favicon ---- */

  await sharp(mark.data)
    .resize(64, 64, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png({ compressionLevel: 9 })
    .toFile(`${OUT}/icon.png`);

  console.log('\nwrote:');
  console.log('  public/chipship-mark.png      128px tall, rail and topbar');
  console.log('  public/chipship-mark-512.png  512px tall, anywhere larger');
  console.log('  public/chipship-lockup.png    640px wide, full lockup with wordmark');
  console.log('  public/icon.png               64px, browser tab');
  console.log('\nAll transparent. The rail picks the mark up automatically.');
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
