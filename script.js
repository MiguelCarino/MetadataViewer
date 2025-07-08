// Elements
const dropArea = document.getElementById("drop-area");
const fileElem = document.getElementById("fileElem");
const output = document.getElementById("output");
const copyBtn = document.getElementById("copyBtn");
const downloadTxtBtn = document.getElementById("downloadTxtBtn");
const downloadCsvBtn = document.getElementById("downloadCsvBtn");
const mediaProbe = document.getElementById("mediaProbe");

let currentMetadata = {};

// Setup drag/drop
dropArea.addEventListener("click", () => fileElem.click());
dropArea.addEventListener("dragover", e => { e.preventDefault(); dropArea.classList.add("highlight"); });
dropArea.addEventListener("dragleave", () => dropArea.classList.remove("highlight"));
dropArea.addEventListener("drop", e => {
  e.preventDefault();
  dropArea.classList.remove("highlight");
  const file = e.dataTransfer.files[0];
  if (file) handleFile(file);
});
fileElem.addEventListener("change", () => {
  const file = fileElem.files[0];
  if (file) handleFile(file);
});

// Handle the uploaded file
function handleFile(file) {
  const baseMeta = {
    "File Name": file.name,
    "Type (MIME)": file.type || "Unknown",
    "Size (bytes)": file.size,
    "Last Modified": new Date(file.lastModified).toString()
  };

  const reader = new FileReader();

  reader.onload = function () {
    const buffer = reader.result;
    const view = new DataView(buffer);

    const magic4 = new TextDecoder().decode(new Uint8Array(buffer, 0, 4));
    const magic2 = new TextDecoder().decode(new Uint8Array(buffer, 0, 2));
    const magicDICM = new TextDecoder().decode(new Uint8Array(buffer, 128, 4));

    const isZipMagic = magic4 === "PK\u0003\u0004";
    const isOfficeZip = isZipMagic && (
      file.name.match(/\.(docx|xlsx|pptx)$/i) ||
      file.name.match(/\.(odt|ods|odp)$/i)
    );
    const isSqlite = file.name.match(/\.(sqlite|db)$/i);
    const codeExtensions = /\.(js|ts|py|java|c|cpp|h|cs|html|css|sh|bash|php|rb|go|rs|swift|kt|lua|r)$/i;

    if (magicDICM === "DICM") {
    parseDicom(buffer, baseMeta);
    } else if (magic2 === "MZ") {
      parseExe(buffer, baseMeta);
    } else if (isOfficeZip) {
      parseOfficeMetadata(buffer, baseMeta, file.name);
    } else if (isZipMagic) {
      parseZip(buffer, baseMeta);
    } else if (isSqlite) {
      parseSqlite(buffer, baseMeta); // async, handles display inside
    } else if (file.name.match(codeExtensions)) {
      parseCodeFile(file, baseMeta);
    } else if (file.type.startsWith("image/")) {
      parseImageExif(buffer, baseMeta);
    } else if (file.type.startsWith("text/") || file.name.match(/\.(txt|csv|md|log)$/i)) {
      parseText(file, baseMeta);
    } else if (file.type.startsWith("video/") || file.type.startsWith("audio/")) {
      parseMediaMetadata(file, baseMeta);
    } else {
      displayMetadata(baseMeta);
    }

  };

  reader.readAsArrayBuffer(file);
}

// DICOM: full tag dump
function parseDicom(buffer, baseMeta) {
  try {
    const byteArray = new Uint8Array(buffer);
    const dataSet = window.dicomParser.parseDicom(byteArray);
    const elements = dataSet.elements;
    for (let tag in elements) {
      const val = dataSet.string(tag);
      if (val) baseMeta[tag] = val;
    }
    displayMetadata(baseMeta);
  } catch (err) {
    baseMeta["DICOM Error"] = err.message;
    displayMetadata(baseMeta);
  }
}

// Basic Office files
function parseOfficeMetadata(buffer, baseMeta, fileName) {
  JSZip.loadAsync(buffer).then(zip => {
    const corePath = fileName.endsWith(".odt") ? "meta.xml" : "docProps/core.xml";
    const appPath = fileName.endsWith(".odt") ? null : "docProps/app.xml";

    if (zip.files[corePath]) {
      zip.files[corePath].async("string").then(xml => {
        const parser = new DOMParser();
        const doc = parser.parseFromString(xml, "application/xml");

        function getText(tag) {
          const el = doc.getElementsByTagName(tag)[0];
          return el ? el.textContent : null;
        }

        baseMeta["Title"] = getText("dc:title") || getText("title");
        baseMeta["Creator"] = getText("dc:creator") || getText("creator");
        baseMeta["Modified"] = getText("dcterms:modified") || getText("date");
        baseMeta["Created"] = getText("dcterms:created");

        if (appPath && zip.files[appPath]) {
          zip.files[appPath].async("string").then(appXml => {
            const doc2 = parser.parseFromString(appXml, "application/xml");
            baseMeta["Application"] = doc2.getElementsByTagName("Application")[0]?.textContent || "";
            baseMeta["Pages"] = doc2.getElementsByTagName("Pages")[0]?.textContent || "";
            baseMeta["Words"] = doc2.getElementsByTagName("Words")[0]?.textContent || "";
            displayMetadata(baseMeta);
          });
        } else {
          displayMetadata(baseMeta);
        }
      });
    } else {
      baseMeta["Office Error"] = "Could not find metadata XML";
      displayMetadata(baseMeta);
    }
  }).catch(err => {
    baseMeta["ZIP Error"] = err.message;
    displayMetadata(baseMeta);
  });
}

function parseStructuredText(file, baseMeta) {
  const reader = new FileReader();
  reader.onload = () => {
    const text = reader.result;
    const lines = text.split(/\r?\n/);
    baseMeta["Line Count"] = lines.length;

    try {
      if (file.name.endsWith(".json")) {
        const json = JSON.parse(text);
        baseMeta["Root Keys"] = Object.keys(json).join(", ");
      } else if (file.name.endsWith(".xml") || file.name.endsWith(".svg")) {
        const xml = new DOMParser().parseFromString(text, "application/xml");
        baseMeta["Root Tag"] = xml.documentElement.nodeName;
      } else if (file.name.endsWith(".csv")) {
        const headers = lines[0].split(",");
        baseMeta["CSV Columns"] = headers.length;
        baseMeta["CSV Headers"] = headers.join(", ");
        baseMeta["Row Count"] = lines.length - 1;
      } else if (file.name.match(/\.(ini|cfg)$/i)) {
        const sections = [...text.matchAll(/^\[(.+?)\]/gm)].map(m => m[1]);
        baseMeta["Sections"] = sections.join(", ");
      } else if (file.name.endsWith(".md")) {
        const headers = lines.filter(l => l.startsWith("#"));
        baseMeta["Markdown Headings"] = headers.length;
      }
    } catch (e) {
      baseMeta["Parse Error"] = e.message;
    }
    displayMetadata(baseMeta);
  };
  reader.readAsText(file);
}

// EPUB (extract OPF metadata)
function parseEpub(buffer, baseMeta) {
  JSZip.loadAsync(buffer).then(zip => {
    const containerPath = "META-INF/container.xml";
    return zip.file(containerPath).async("string").then(containerXML => {
      const parser = new DOMParser();
      const containerDoc = parser.parseFromString(containerXML, "application/xml");
      const rootfile = containerDoc.querySelector("rootfile").getAttribute("full-path");
      return zip.file(rootfile).async("string").then(opfXML => {
        const opf = parser.parseFromString(opfXML, "application/xml");
        const meta = tag => opf.getElementsByTagName(tag)[0]?.textContent || "";
        baseMeta["EPUB Title"] = meta("dc:title");
        baseMeta["Author"] = meta("dc:creator");
        baseMeta["Language"] = meta("dc:language");
        baseMeta["Publisher"] = meta("dc:publisher");
        displayMetadata(baseMeta);
      });
    });
  }).catch(err => {
    baseMeta["EPUB Error"] = err.message;
    displayMetadata(baseMeta);
  });
}

// PDF (simple PDF.js preview for metadata)
function parsePdf(file, baseMeta) {
  pdfjsLib.getDocument({ data: file }).promise.then(pdf => {
    baseMeta["PDF Pages"] = pdf.numPages;
    return pdf.getMetadata();
  }).then(meta => {
    baseMeta["Title"] = meta.info.Title || "";
    baseMeta["Author"] = meta.info.Author || "";
    baseMeta["Creation Date"] = meta.info.CreationDate || "";
    displayMetadata(baseMeta);
  }).catch(err => {
    baseMeta["PDF Error"] = err.message;
    displayMetadata(baseMeta);
  });
}

// MP3, OGG, FLAC using music-metadata-browser
function parseAudioBuffer(file, baseMeta) {
  musicMetadata.parseBlob(file).then(metadata => {
    baseMeta["Title"] = metadata.common.title || "";
    baseMeta["Artist"] = metadata.common.artist || "";
    baseMeta["Album"] = metadata.common.album || "";
    baseMeta["Duration"] = metadata.format.duration?.toFixed(2) + "s";
    baseMeta["Sample Rate"] = metadata.format.sampleRate;
    baseMeta["Bitrate"] = metadata.format.bitrate;
    displayMetadata(baseMeta);
  }).catch(err => {
    baseMeta["Audio Error"] = err.message;
    displayMetadata(baseMeta);
  });
}

// SQLite using sql.js (WASM)
async function parseSqlite(buffer, baseMeta) {
  try {
    const SQL = await initSqlJs({ locateFile: filename => `https://sql.js.org/dist/${filename}` });
    const db = new SQL.Database(new Uint8Array(buffer));
    const tables = db.exec("SELECT name FROM sqlite_master WHERE type='table'");
    baseMeta["SQLite Tables"] = tables[0]?.values.map(row => row[0]).join(", ") || "None";
    displayMetadata(baseMeta);
  } catch (err) {
    baseMeta["SQLite Error"] = err.message;
    displayMetadata(baseMeta);
  }
}

function parseCodeFile(file, baseMeta) {
  const reader = new FileReader();
  reader.onload = () => {
    const text = reader.result;
    const lines = text.split(/\r?\n/);

    const ext = file.name.split('.').pop().toLowerCase();
    const languageMap = {
      js: "JavaScript",
      ts: "TypeScript",
      py: "Python",
      java: "Java",
      c: "C",
      cpp: "C++",
      h: "C Header",
      cs: "C#",
      html: "HTML",
      css: "CSS",
      sh: "Shell Script",
      bash: "Bash Script",
      php: "PHP",
      rb: "Ruby",
      go: "Go",
      rs: "Rust",
      swift: "Swift",
      kt: "Kotlin",
      lua: "Lua",
      r: "R"
    };
    const language = languageMap[ext] || "Unknown";

    const commentSymbols = ["//", "#", "/*", "<!--"];
    let commentLines = 0;
    let functionCount = 0;
    let classCount = 0;
    let shebang = "";

    lines.forEach((line, index) => {
      const trimmed = line.trim();
      if (index === 0 && trimmed.startsWith("#!")) {
        shebang = trimmed;
      }
      if (commentSymbols.some(sym => trimmed.startsWith(sym))) {
        commentLines++;
      }
      if (/\bfunction\b|def\s|=>/.test(trimmed)) {
        functionCount++;
      }
      if (/\bclass\b/.test(trimmed)) {
        classCount++;
      }
    });

    baseMeta["Programming Language"] = language;
    baseMeta["Total Lines"] = lines.length;
    baseMeta["Function Count"] = functionCount;
    baseMeta["Class Count"] = classCount;
    baseMeta["Comment Lines"] = commentLines;
    baseMeta["Comment Ratio"] = ((commentLines / lines.length) * 100).toFixed(1) + "%";
    if (shebang) baseMeta["Shebang"] = shebang;
    baseMeta["Preview"] = lines.slice(0, 10).join("\n");
    displayMetadata(baseMeta);
  };
  reader.readAsText(file);
}


// Basic ZIP
function parseZip(buffer, baseMeta) {
  JSZip.loadAsync(buffer).then(zip => {
    baseMeta["ZIP File Count"] = Object.keys(zip.files).length;
    let fileList = Object.keys(zip.files).slice(0, 10).join(", ");
    if (fileList.length > 9000) fileList = fileList.slice(0, 300) + "...";
    baseMeta["ZIP Contents (first 10)"] = fileList;
    displayMetadata(baseMeta);
  }).catch(err => {
    baseMeta["ZIP Error"] = err.message;
    displayMetadata(baseMeta);
  });
}

// Basic Text parsing
function parseText(file, baseMeta) {
  const reader = new FileReader();
  reader.onload = () => {
    const text = reader.result;
    const lines = text.split(/\r\n|\n/);
    baseMeta["Line Count"] = lines.length;
    baseMeta["First Lines"] = lines.slice(0, 5).join(" / ");
    displayMetadata(baseMeta);
  };
  reader.readAsText(file);
}


// Basic Exe parsing
function parseExe(buffer, baseMeta) {
  try {
    const view = new DataView(buffer);
    const peOffset = view.getUint32(0x3C, true);
    const peSig = view.getUint32(peOffset, false);

    if (peSig !== 0x50450000) throw new Error("Not a valid PE file");

    const machine = view.getUint16(peOffset + 4, true);
    const timestamp = view.getUint32(peOffset + 8, true);
    const entryPoint = view.getUint32(peOffset + 40, true);

    baseMeta["EXE Architecture"] = machine === 0x14c ? "x86" :
                                   machine === 0x8664 ? "x64" : `Unknown (${machine.toString(16)})`;
    baseMeta["PE Entry Point"] = "0x" + entryPoint.toString(16);
    baseMeta["PE Timestamp"] = new Date(timestamp * 1000).toString();

    displayMetadata(baseMeta);
  } catch (err) {
    baseMeta["EXE Error"] = err.message;
    displayMetadata(baseMeta);
  }
}

// Basic EXIF (EXIF block length)
function parseImageExif(buffer, baseMeta) {
  try {
    const view = new DataView(buffer);
    let offset = 2;
    while (offset < view.byteLength) {
      const marker = view.getUint16(offset);
      if (marker === 0xFFE1) {
        const exifLength = view.getUint16(offset + 2);
        baseMeta["EXIF Segment Length"] = exifLength;
        break;
      }
      offset += 2;
    }
  } catch (e) {
    baseMeta["EXIF Error"] = e.message;
  }
  displayMetadata(baseMeta);
}

// Video/Audio: duration, resolution
function parseMediaMetadata(file, baseMeta) {
  const url = URL.createObjectURL(file);
  mediaProbe.src = url;

  mediaProbe.onloadedmetadata = () => {
    baseMeta["Duration (s)"] = mediaProbe.duration.toFixed(2);
    if (mediaProbe.videoWidth) {
      baseMeta["Resolution"] = `${mediaProbe.videoWidth}×${mediaProbe.videoHeight}`;
    }

    // Subtitle Tracks
    const textTracks = mediaProbe.textTracks;
    baseMeta["Subtitle Tracks"] = textTracks.length;
    if (textTracks.length > 0) {
      baseMeta["Subtitle Languages"] = Array.from(textTracks).map(t => t.language || "unknown").join(", ");
    }

    // Audio Tracks (note: experimental & limited)
    if (mediaProbe.audioTracks && mediaProbe.audioTracks.length > 0) {
      baseMeta["Audio Tracks"] = mediaProbe.audioTracks.length;
      baseMeta["Audio Track Info"] = Array.from(mediaProbe.audioTracks).map((t, i) => `Track ${i + 1}`).join(", ");
    } else {
      baseMeta["Audio Tracks"] = "Unavailable (browser limitation)";
    }

    URL.revokeObjectURL(url);
    displayMetadata(baseMeta);
  };

  mediaProbe.onerror = () => {
    baseMeta["Media Error"] = "Could not parse media metadata.";
    URL.revokeObjectURL(url);
    displayMetadata(baseMeta);
  };
}


// Display and update output
function displayMetadata(data) {
  currentMetadata = data;
  const lines = Object.entries(data).map(([k, v]) => `${k}: ${v}`);
  output.textContent = lines.join("\n");
}

// Export buttons
copyBtn.addEventListener("click", () => {
  navigator.clipboard.writeText(output.textContent).then(() => alert("Copied to clipboard!"));
});
downloadTxtBtn.addEventListener("click", () => {
  const blob = new Blob([output.textContent], { type: "text/plain" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "metadata.txt";
  a.click();
});
downloadCsvBtn.addEventListener("click", () => {
  const csv = Object.entries(currentMetadata).map(([k, v]) => `"${k}","${v}"`).join("\n");
  const blob = new Blob([csv], { type: "text/csv" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "metadata.csv";
  a.click();
});
