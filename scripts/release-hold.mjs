export function assertPublishBlocked() {
  throw new Error("external live evidence is not verified by this repository; publishing is disabled");
}

if (process.argv[1] && process.argv[1].endsWith("release-hold.mjs")) {
  try {
    assertPublishBlocked();
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
