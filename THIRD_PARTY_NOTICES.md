# הודעות צד שלישי / Third-Party Notices

**עברית:** CashWatch בנוי על תוכנות קוד פתוח. להלן הרישיונות שלהן, כפי שהם מופיעים בחבילות עצמן (מועתקים כלשונם). הרישיונות האלה חלים על רכיבי הצד השלישי בלבד, ולא על הקוד של CashWatch עצמו.

**English:** CashWatch is built on open-source software. Below are the licenses of those components, reproduced verbatim from the packages themselves. They apply to the third-party components only, not to CashWatch's own code.

---

## 1. israeli-bank-scrapers (המגרד של אתרי הבנקים / the bank-site scraper)

CashWatch משתמש בספרייה הפתוחה **israeli-bank-scrapers** כדי להתחבר לאתרי הבנקים וחברות האשראי בשם המשתמש ולקרוא את הנתונים שלו. הגרסה מקובעת ל-6.13.0, ו-CashWatch מחיל עליה תיקונים קטנים בזמן ריצה (`src/scrape/patches.ts`) בלי לשנות את קבצי המקור בחבילה המופצת.

CashWatch uses the open-source **israeli-bank-scrapers** library to log in to Israeli bank and credit-card sites on the user's behalf and read their data. The version is pinned to 6.13.0; CashWatch applies small runtime patches (`src/scrape/patches.ts`) without redistributing a modified copy of the package.

- **License / רישיון:** MIT
- **Copyright:** (c) 2017 Elad Shaham
- **Project / פרויקט:** https://github.com/eshaham/israeli-bank-scrapers

```text
MIT License

Copyright (c) 2017 Elad Shaham

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

תודה לאלעד שחם ולכל התורמים לפרויקט. / Thanks to Elad Shaham and all contributors of the project.

---

## 2. תלויות ריצה נוספות / Other runtime dependencies

| Package | Version | License | Copyright holder (per package) |
|---|---|---|---|
| express | 5.3.0 | MIT | TJ Holowaychuk, Roman Shtylman, Douglas Christopher Wilson |
| node-cron | 4.6.0 | ISC | Lucas Merencia |
| nodemailer | 10.3.1 | MIT-0 | Andris Reinman |
| yaml | 2.9.1 | ISC | Eemeli Aro |
| zod | 4.6.7 | MIT | Colin McDonnell |
| puppeteer (transitive, via israeli-bank-scrapers) | 24.43.1 | Apache-2.0 | The Chromium Authors |

### express (MIT)

Copyright holders as listed in the license text below.

```text
(The MIT License)

Copyright (c) 2009-2014 TJ Holowaychuk <tj@vision-media.ca>
Copyright (c) 2013-2014 Roman Shtylman <shtylman+expressjs@gmail.com>
Copyright (c) 2014-2015 Douglas Christopher Wilson <doug@somethingdoug.com>

Permission is hereby granted, free of charge, to any person obtaining
a copy of this software and associated documentation files (the
'Software'), to deal in the Software without restriction, including
without limitation the rights to use, copy, modify, merge, publish,
distribute, sublicense, and/or sell copies of the Software, and to
permit persons to whom the Software is furnished to do so, subject to
the following conditions:

The above copyright notice and this permission notice shall be
included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED 'AS IS', WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.
IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY
CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT,
TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE
SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

### node-cron (ISC)



```text
## ISC License

Copyright (c) 2016, Lucas Merencia \<lucas.merencia@gmail.com\>

Permission to use, copy, modify, and/or distribute this software for any purpose with or without fee is hereby granted, provided that the above copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
```

### nodemailer (MIT-0)

Package metadata declares `MIT-0`; the LICENSE file is reproduced as shipped.

```text
Copyright (c) 2011-2023 Andris Reinman

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### yaml (ISC)



```text
Copyright Eemeli Aro <eemeli@gmail.com>

Permission to use, copy, modify, and/or distribute this software for any purpose
with or without fee is hereby granted, provided that the above copyright notice
and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH
REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY AND
FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT,
INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS
OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER
TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF
THIS SOFTWARE.
```

### zod (MIT)



```text
MIT License

Copyright (c) 2025 Colin McDonnell

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### puppeteer (Apache-2.0)

Puppeteer (https://github.com/puppeteer/puppeteer) מגיע כתלות של israeli-bank-scrapers ומשמש להפעלת דפדפן (Edge/Chrome של המערכת). הרישיון הוא Apache License 2.0; החבילה המותקנת אינה כוללת קובץ LICENSE נפרד, והטקסט המלא זמין ב: https://www.apache.org/licenses/LICENSE-2.0 (ובמאגר Puppeteer). CashWatch אינו כולל בחבילה את דפדפן Chromium: הוא משתמש ב-Edge/Chrome שכבר מותקן אצל המשתמש.

Puppeteer is a dependency of israeli-bank-scrapers and drives the system's Edge/Chrome. It is licensed under the Apache License 2.0; the installed package ships no separate LICENSE file, and the full text is at https://www.apache.org/licenses/LICENSE-2.0. CashWatch does not bundle Chromium; it uses the Edge/Chrome already installed on the user's machine. Further transitive dependencies of the packages above are distributed under their own licenses, found in their respective packages under `node_modules/`.

---

## 3. גופן Heebo / Heebo font (SIL Open Font License 1.1)

הקבצים ב-`web/fonts/` (`heebo-*-wght-normal.woff2`) הם הגופן Heebo, דרך החבילה `@fontsource-variable/heebo`. הגופן מופץ ברישיון SIL OFL 1.1, שמתיר שימוש והפצה חופשיים בכפוף להצמדת הודעת זכויות היוצרים והרישיון (להלן).

The files in `web/fonts/` (`heebo-*-wght-normal.woff2`) are the Heebo typeface, via the `@fontsource-variable/heebo` package, distributed under the SIL OFL 1.1 (copyright notice and license reproduced below).

```text
Copyright 2014 The Heebo Project Authors (https://github.com/OdedEzer/heebo)

This Font Software is licensed under the SIL Open Font License, Version 1.1.
This license is copied below, and is also available with a FAQ at:
http://scripts.sil.org/OFL


-----------------------------------------------------------
SIL OPEN FONT LICENSE Version 1.1 - 26 February 2007
-----------------------------------------------------------

PREAMBLE
The goals of the Open Font License (OFL) are to stimulate worldwide
development of collaborative font projects, to support the font creation
efforts of academic and linguistic communities, and to provide a free and
open framework in which fonts may be shared and improved in partnership
with others.

The OFL allows the licensed fonts to be used, studied, modified and
redistributed freely as long as they are not sold by themselves. The
fonts, including any derivative works, can be bundled, embedded,
redistributed and/or sold with any software provided that any reserved
names are not used by derivative works. The fonts and derivatives,
however, cannot be released under any other type of license. The
requirement for fonts to remain under this license does not apply
to any document created using the fonts or their derivatives.

DEFINITIONS
"Font Software" refers to the set of files released by the Copyright
Holder(s) under this license and clearly marked as such. This may
include source files, build scripts and documentation.

"Reserved Font Name" refers to any names specified as such after the
copyright statement(s).

"Original Version" refers to the collection of Font Software components as
distributed by the Copyright Holder(s).

"Modified Version" refers to any derivative made by adding to, deleting,
or substituting -- in part or in whole -- any of the components of the
Original Version, by changing formats or by porting the Font Software to a
new environment.

"Author" refers to any designer, engineer, programmer, technical
writer or other person who contributed to the Font Software.

PERMISSION & CONDITIONS
Permission is hereby granted, free of charge, to any person obtaining
a copy of the Font Software, to use, study, copy, merge, embed, modify,
redistribute, and sell modified and unmodified copies of the Font
Software, subject to the following conditions:

1) Neither the Font Software nor any of its individual components,
in Original or Modified Versions, may be sold by itself.

2) Original or Modified Versions of the Font Software may be bundled,
redistributed and/or sold with any software, provided that each copy
contains the above copyright notice and this license. These can be
included either as stand-alone text files, human-readable headers or
in the appropriate machine-readable metadata fields within text or
binary files as long as those fields can be easily viewed by the user.

3) No Modified Version of the Font Software may use the Reserved Font
Name(s) unless explicit written permission is granted by the corresponding
Copyright Holder. This restriction only applies to the primary font name as
presented to the users.

4) The name(s) of the Copyright Holder(s) or the Author(s) of the Font
Software shall not be used to promote, endorse or advertise any
Modified Version, except to acknowledge the contribution(s) of the
Copyright Holder(s) and the Author(s) or with their explicit written
permission.

5) The Font Software, modified or unmodified, in part or in whole,
must be distributed entirely under this license, and must not be
distributed under any other license. The requirement for fonts to
remain under this license does not apply to any document created
using the Font Software.

TERMINATION
This license becomes null and void if any of the above conditions are
not met.

DISCLAIMER
THE FONT SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO ANY WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT
OF COPYRIGHT, PATENT, TRADEMARK, OR OTHER RIGHT. IN NO EVENT SHALL THE
COPYRIGHT HOLDER BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY,
INCLUDING ANY GENERAL, SPECIAL, INDIRECT, INCIDENTAL, OR CONSEQUENTIAL
DAMAGES, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
FROM, OUT OF THE USE OR INABILITY TO USE THE FONT SOFTWARE OR FROM
OTHER DEALINGS IN THE FONT SOFTWARE.
```

---

## 4. סימנים מסחריים ובנקים / Trademarks and banks

**עברית:** שמות הבנקים וחברות האשראי, והסמלים והלוגואים שלהם, שייכים לבעליהם. CashWatch **אינו קשור, אינו מאושר ואינו מקבל חסות** מאף בנק או חברת אשראי. הסמלים (favicon) מורדים **במחשב של המשתמש עצמו**, מהאתרים הרשמיים של הספקים שהמשתמש הגדיר, ונשמרים אצלו מקומית (`data/logos`). הם **אינם נכללים בחבילת התוכנה ואינם מופצים מחדש**. אם אין חיבור או שהורדה נכשלה, מוצגת מונוגרמה צבעונית בלבד. השימוש בשמות נועד אך ורק לזהות את החשבונות של המשתמש.

**English:** Bank and credit-card company names, symbols and logos belong to their respective owners. CashWatch is **not affiliated with, endorsed by, or sponsored by** any bank or card issuer. Icons (favicons) are downloaded **on the user's own machine** from the official sites of the providers the user configured and kept locally (`data/logos`). They are **not included in the software package and are not redistributed**. If the download fails, a colored monogram is shown instead. Names are used solely to identify the user's own accounts.
