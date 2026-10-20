 'use strict';
const { test, before, after, mock } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { gunzipSync } = require('node:zlib');
const { CONTRACT, fetchDailyAnnouncement, replayDailyAnnouncement } = require('../scripts/lib/daily-arxiv-announcement-source');
// Actual official eess.AS RSS retrieved on 2026-10-20, announcing Monday 19 Oct.
// Complete captured bytes, including all 12 new/cross/replace/replace-cross items.
// Original SHA-256: cde24045c8c69605e72e2618725440ddd3534a18afc9279bcfb8a2277de63285
const ORIGINAL = gunzipSync(Buffer.from('H4sIAAAAAAAC/+19+3MbN5bu7/NXoFybsl3Dpl62MtZ1vCvbcmzHin1NjTMzNVVbIBskETUbTD8kM1v3f7/fdw7Q3ZRkj+ykdrd2dmoqEUk0+uDgPL7zAPL4Xz+uCnPhqtqH8ru7e+Pdu8aVs5D7cvHd3T+fvcj+dPdfn/zhcVXXBiPL+shWH/3Fd3eWTbM+2tmRT+NQLXbq2dKtbL1jm7C6E8fms27guq0KGZfPdlzhVq5s6p298d5OGsvnutGXl5fjywMZv7+7+3DneDDpLJQNnr4+M2jEjLs7q5C3hat34kC8Ia3vzv54986TPxjzeLa0ZekK/o1PjW8K98S5uh4fT0y7zm3jahNKY6u/6PIe7+gYHV/48vxJfD3eOu65QBriPI93ZJg+kbt6Vvl1Aypuek+zdP27jMvWlS8bfDNb+gs3frwzfFwnJLuO+AKzrNy8Y8YnqbljKld8d6d2xfyOaTZr990du14XfmY5KUf+Eey9s5PoDbP6yWAz8Ps02CpP02b12s38PD4OAjk+MseWi9YuwM8ya2twIX1OP9fN09YX+XMs/slpKEdm75F5O2vM/u7+odl9cLS7e7R/YP64i//x6eFwnWJlS7uAgJ7kvgnVE5KzdMX637qFP965MkSfW7fTT7x090j+b7LdB3xpGqiP1ed+/dxu4vrIHLt5MmlL/AsLx99b39umrbZ/ebyzPcNj37hV95DK1dPK5ws3Ms993fiiGJn3bu5Ld2Re+sUye+FzV/hmY96WLps0bm2+d6WrhPdmHipz2haNz57aMr/0ebM0k7Vzs6U5+QgFqGWDBuI7FOB6S4fttN7ZP9zbHe/vP9rbHQrwFREWWT3qh17smeOyDG05c+YMwnVkSndp/nA8rZvKzpqjRNC0o9Al0sy9pz+d3DfWr2rTBEjpLEBdzcrXNfbPUM4wR2GiNpt5FVYyT1b4FTiZcwjmHpuX4dLh0ZFZhboxi8ihC2fwArNyzTLkNXTKGazEL0o8SdbN/Uf85ct12/TkYVyZU2M21E68Jc5U2xV0plyMjLycBEJ1PWYp3Ec/9bJJfNTNoRselnQzNj85s67COtSg5Pn7DNSMjMVzlXNZ3UAzhrTOK7tyl6E6F+JWsq8913SpPfPG5oWv6mZEzrnSTgtHPkHm8Rt4thhICdlGMxOmtasusOSrPASb29XIXCb+gMZZ24T5PLOX5Npw4nkRLs1UZBask3lnYbWuYGswGf8EP8zk7MWZycPKeujbPMxa2dEBUdHypb1eUtbnlfulJeOEQHO59AX550g1B3X0d5LhS7BqJTOOzcSRzhE5viA55Cm+qaFXMmmuCqbv72iulQ7hdk39kgVi9rJeh6rBK8BgC3qd/hzXEKqxOVv6Cu+zOZ2MrTwIqkR3VyKtbYWZK+PxIsh1fXWNuWusL0RklrZahdLPQBWewK9unOTFWDgCx8chL43LwjzDrJkFZUVYZB0nuDhLHbz3ZvL8Ptn74dnZD3i6CvDftiiMu7BFa5u4/VHWLz1Eq1sb2KmvH0Xmc/9AZUnuk2MOtoRsXbtq5tZNixf/gn8k0VfeFP5Xjr90eCl4d3L8fjI2x23ugyqRU1W0F1i+yK1tTGeQ/K9L/4vPqAbjBYhrp2MfdqZ5lU0vXZa7VbjJJ8JGLVoPXa7fOcjDGxiv7+7MbVG7O0+C9Uedg90yXI93+FA3AxyaW4Rq86Tz4t03acjXuRH6bBraIxsN5b/TCz+BnXy8c9MPndmdHVWQmaZzx7PKianAVkBeajHc8OMwCMA8001WzrLa7jwAEAKPuocH08kEcIp/I5PNsR+Zv7RmsnRYzWlozU+W9u2voVz8DNX+2zK0I/zaLvAFBsqcaYbo3np/dpNrO56FFjo3O4ZgwBMcmxdFCNUasCB7hm8qSPzEQ/VUJd/h31RnMX/0hpWftpRXdXHvA8xYdCbvqjBzYjm+wr0dHN7avR0c/kP3dvKRZgUMsnGxpu6X1IRQ1MZ5MQTRcjhTcSUwCy3kExYDdoYbaO69f/W+vt/5jwYeCLuwtnQLcEP+V7CCjwI2Vp2DWtNrliCmnZFV6lpyv1InAf2sIR6uhme056TSNzAVfAN4Su2cEmCZwlYw52W7msKSmTA3DvZedBPkAYGUDY2bGkmh3pUXvgqlYPno5mCmYfW2tpzObt5t+Sxu+U2MWqe9b5awBlgRTGpDm8d1tRUddpqnVpOcKBx188HIbfho6YQVA2qVB+Nt4szPwQuTETQ47JKMXLgAZldqzuJc/gL2bUR7XnrSQl5yP2BeRqaGaOT8JwwiPvKxlYfRXS9hVTnD3C9a9XkkQEnJQsUNBpGJInOapjSwG3ZqaxrfNTiAyKrkgBQ5cdM6DnbCUSeLPWS4Ou/lht46rYxsytLzmD4UFwPRrJVrMUQyFMgIhzAKsmEZmtCS0/m5ftdAN4x7u6bHrCFgFdkm4icMCeK+OyblA93umRW59+HNaWZrcdq5cst0At6hmW6NUCOgKCWyATYamz8LnrgihpeDScyLdxkWRtlEEAZGU96wPD6293B08O3hltAP5E6cZe7p7aMSN8B2cMOexBPo2UVCFxEwxUXp0rMMfHF8/ppgQIPgnj2jQqho3e/wPOF/TO2xAtCGDYR7hNaunK0hjyoWAj2ji4cshMJlS+x4fDXAwoyOWd436sBkuSRmWKmqYoK5rbK5d0VC1lxUNLQGcg7C+WdBR3wBvyPP3LybENyGZrFWSQFHIVgQDbeSfSCRxF0wdqJh1E8xPFelV5STr6dTEDOV1VjJtmG6yaKIROANU0w9J0sx+ZDUem3l2cEKYW0/aeK2TQcnVzHi8xcgxJAqRTNqOXR7owlVyZc1gHOuCGvxGP2W8eNwRZH99QZqsKp/H8hDZ/Y/EfKU+ZdBnpcwG8+AeRYEN37jgS9+T9DzggbqFfQfYkGAPMFEYrVPEQTNzDOId6gsgEO/8ycfIfFeg7iXKRZ47maePjw7Vc8NmX4Zwjm0Cdvz5bDnwd6tYQ+GXoc9GkgMgM8xIkSGXjPYoSLkmxTFqI2BXELjEHgN4g6Ak9AultCzjjkMKkKtppKwhhY5yysaBPxWrds6umeJtggIWrzJfbQrhFmwyEsn0Ao76gY87OKpPPJQJ0m6F8P/ARm17NEM00yhwEyOkdzAIW7tylzR2CwUhWKLZQuvbCjCjVpw8Q2hhSuBRV0o0AKkYDJSjHtnmS0d2K9Y3XDPT5WBcet/xYLunZy+lCiudvGV/d5jqTNXrTE/EyMxOoNxl7xG3AsxQstQ5UMixwazDny9Dqg1IKV5ouSmCQoacQ3byVpAUiyu8oJSNEHBgRKzrmhKNQMy6nk/h/Cot1kzBytBOLDTzOb6h+CWaOVrt6Cdjd5JYADfNPVZ4c+dCRDSVRSssXkpzBfiNZIk75d0WnlbXUkzcKqWiYlQYgNJNsStgWeMdFceWz+GRvwIeWocxTUxd0M/iCcfHDyK27clWpFkMvUj9CFxewH8LeE/TMZsicf3d8cPd78Z6e/0LM1g0MHe+PDwm9FWEiBLjBuMe/Dt+HAf4wSBpN+xeOYvuDpEA5pDgszS6Z27jQbzRM7TDfd93BuUgmqAd9pig30x6nTmXog96BZm7j04HO8/+OY+taxSd73sWQ9njACkbeizNIVCFbsrWpQrkLkA5pjCH0c4vffg0Nw7OBjvH3ZzQqYubT1IBcA3G8hrJ/aCHoC25lRW6miu0Vbr6yVWHaMOG8GmpLSiQoowM9TRjAajhk7gC4WnndI24mQ0oxfXWLn4IJisyTMK0IomXOIMQWuEz60KJUGOGqcBxMHKhMiQtzMvsQoiDkhX5TS4gqWpAsSE26bWLiPy71EBE2Xz6+Ys02Dud4EFYuw/BQtm9Xjy/AZQMBxw/OpzA/6TgIV4py+EFr2b7ABFCaP3cVa0zB1mES1KYekfgIvXoXZz885eFH+/6/9+8R+z/+fOR4jpKkiVeQcAe/73u7b8cizx+vjDq8mRec1IVVNo2Qdf02O9oiDZWWfkJpThVQLK7xkknHnA/2cSStdJQwS+1l+BHh49ujV6ePToFughGnGguraMpSRCBl9KAlTCckJxGBVbjDQhsFGMLqUA2gjRyIQpCjUKhCNkB00P0EULFaRJkfg0Db1QDjLRbQksuuKBS6mc2TbTIgqHHl5oSlRcySz6FYk7iV0Us49M4aymq2lZYBbi++bO5VM7O9cUB9ZK0x1jTDxdsnokKe1uY8fYZYzG0LVdk8DLvpwgkjES4FPmWRMyxzCzF4KtWoLEjA3FQYL3LFJ0ZZl2of7sbVupA8mdJZ0wToWLSwkp6uOnucUHrNqeq7W1MTq8YpgxIzNha5oyDIE1A9/evDllBK6SrRUvYBxnc6PmUmwnREPc0hbV25NL3gMWFHTOpZgDauG1KVJuyJBphUh3GWOwGF1pxDtzA8AQYeaAp6kigqXnte7OCvPTv01DAy0q3ewcYb7UYDSMS8we4BBNzpw7t46Vra33NzQsEKp6AxorgYC5bL7NNY0Qt15TbLL12WRDpGQODh4AzWDH8Cz2pBFAJri5K3UxYZTnLHbIrhWUQab4Pq5TlWSLv1hbERatEyw+6nMjcGsqKCC0Iss1VobUlluSpKkITeHYssnqZoOlw6wSGTvBSxBmrxijXrLYQoWQVfXVDnGNHz0zbXjf/u7uv/ydPK3/xRRQV4J3L6oD3CPVFMzBshU2nHEbvSg2o6tjQBXxTqaq/OBXwQSFXw/43qNGbAznT1zityRpXXHrma34fbwvjeVnvO+zD//rXF+3eDycm+Ml1vLauuWmhVO1FTzsa8fALQTE8wGR/euAbUK8jY8tw/vXPnvJr37wqy/3vc+zZxKcuurIvImNDOZ0mI6S2gVk3AWo2/OqXZkzlg2TSKhflvzwyQUV97kbhLtf7oMfHjy8rQ/G0Fv4YCF5CpZoGKXhOlQ5lvak4MA1RItMpcbAimqs2gsrAmvs1NTGxCDn1KS4u9BBlRYYl4HORd55HEOPbLqhHYNVYhxy73g6uZ+y8eDUFCqq7i+VAeik6rpdrTv0bgblDwJjhc9Yn0bFMH1R783pq/emsfU5Zmtpe2EgSUoz3LGRSeQzZVo7ptf7kDStgjX46KFHYMFczaONjQCE9QWcRNkFZKvA6KmyXQmdZHRdNEybs76tNf0OiwBE5JLInk66MMEpJxZ0sZi3q7bKJwsXF+A+ZXsk2SnL86tpxdqSGy/GIyORT6WxBH8+9019f9QVk6RCnQq6a+urzvdusannr7oIyQIHwWSaZ4GXrGw2KyxdDinAoi9YIO/2zZc9WhiIVKJTXMuaHtPDWYk41ffhm4OhN5oxr91IXDiI+LbgUa+8gpFsC7V3XVdA6ksaZJc7vCTOKI+a6qKUUMoqDUAFYSBYBSvzbUGPsMhT3llVEH8lbvy6pH1KoFRERwP6kwDXMWEBlLHhfkOtpq6BoPWu70p/AEVHoauStiV1vQ9UD7lVuu/FCdPfKFCKEm/O6oN/iO4BTH9p/ZrJNlFUO2XbFLa4ByqUnpgux8rgobo8fhPOXXkF6YEr1/ctZt9rkSb2FnCr/NqJfSZ8lKDhOusHG9dttqjn7+LVxfx+dUz939ir/4Ns/G3y8O8si5Dn5u3d984DS47MxLarjYVH98WlxcLgtryjC6e3r+nRoeOIq55WGyuOPw9f7s0nsY6aPau81IoRdCw0UQRJ+QAZCkT82qbSt9h9sZc+2N3fu6WX5tBbeOlX5bDmR2kPXd05WZ7Oe8PihpkXhyxaF8t+0ZEzysoWNN4uT2EpY+RR5xPD9Gd4CKNQfxQ/Zmuak3xTIpSa1SNNO2OUvl3t/yBsrWmYLplL1ccF8sfI+iIxWtyKufdh//h+16DnoMBhw86ImG5OVdQE2iXcXhRhSn9yUzQoaKNPV4POKjDtz4JCHhvh8JZQxcp0KgKSCQPnW7dTbLryOIvpu1iv0++YjZypg99aeOWYHsB3dTvo4pjZtfQw9KkBKTBKEp3YgD0cvu4SBVvLht3VV6qtSu0AqeId15L2ZgyACqq0y2uj4Em75mwXRkpmU/stVQEGVQQRA30fMIG7oL2OVDluXcyHflqZ7k2esYclSoTiRoPvMmw0w1X8a7s1ccvtpp0Dz5LgxsI2+9LxN2cnATcJMq2tdMCRrypew7h+krqWxeZcMqVc1U1Kfm906pQi6lggnIwvGJbQpajT0MuJb4mtK26gb4m7sX8wyeK2vHYvtDlkxFURv0pNKvE9tuSnREfqWolCVV/RB+mV/dhcV/cru5q2M5Xnt6iC1EhyS9LSURjZLhEuS82oXOOveuTt2B7fTkPDcl+mnaAKetqGICV+MwUNyxViuRtARBSbYQekBPcREMleY4quqC9k2Aajo64qkQnPKs5RDb3az8jaAO1uJvlGLaatUqGfHZteMP7cXSr2lex933yTqhQJDxFHF/SAmjSzRSsAal35QIURjDXcnNEndK4auqgtzfk9YIr6n69OPmDA6ek/GPDPDHT+2pbmhTRU/uS8+b4NI/O3ZYsAsDRvvHz/0kEOfkpDcsr2M+u/HNu8g19bNxO3ziZMxjJh8X3fVn7GppnGxJ94MCDFGhfeam+lSr1Ok5Qn2XhznJThK7DQ4eGtsdDhbXoO4lrquJZB3HTvbHJyH6Ifilh3Y/qz0l5xGRsz1LHRO3658h9pRGOdW8oFmp1PXoH628hLx+AP1NeIt1rCB9FZBYmQU9SSmtCuwypXwvYXalHEKGnjlBYnGzmUI9mURFdiU2BjHwsYGBELj7ARPp5QSgE03mXm8P/FZmz+6lgcGf4CYy5mWOI5TDDou9aDDl5CSphRvHLlNW9BIFG50J+pAHu7OojNwxoYkfEk3AaQUO8B6uSmrOAa9hDQ/WHN8sIKTMWG1dvd4hgZAG43Xbd6YmjfRiex/yCL/ZnQ/5o2EHcMjllwJZqm6CClJJG1Mbat1S1DCLT6QOvbVgrzNIWtZy2wv0fdfnVALFQ5X9gHnKNrex87AuOTdONdAXl4GAQeLrWyMdZlel38CnvwusTUVve9irbq8rrT5e74QTzzlU6qKKvZYGkh18rgeUsJE8EGfGYDA9epaCmdZuhQXdfJ8pO9eHN6FUJozM/My0e8UFoAOqdahDrqWcp9gbxfWldtsqSQ6o1tw30ZVupF4zX9wgK4OdZlyBYNiua1izKGsdJ5IuCW5fnRdfn4zBGLIdSQs0kUHukpKWVHpHXoSrKwT62MIvPl5f3vdjZrYbZ007oN1IVQYWUHIfau/n28/OHh/yYjPumjG3rdn3gA4gcnXYEUELeC+0NQSoDHjMRLK25bf34LdSnMj941UOV37CAyEyBYu4AFHZnXtFylmdjCrsiYv7lNa177r6j9S+X+45s3p0dmwqCC6EC+yl5CTdNJCOkDYBFR6rTq9ovsXVuJLdR0BscU0D7i/S934g8Pblv659BbOPFJX/1UZ7id1qtT373EMr5sWV3pXMLVeF/KvQwOYR7ZVxOjHUBt7InXtLYEREw20qvVjXrl+C7EOeb0zTvmDf5v9gK67qKt73i6sutBO7azGnVJWEd0EN9+t44HCeu1ZXdbHzQMBmkp3ValkbJn6NuBZJSGD1pD3lqlRJseew8aFtrfrX2Pi4pxQ3xL7a5xJx7Q62nsWhyEJ241dbmmtdn7yJO0bMkiT7oVD47YxRAqpp0HB/PY6zhgvswNx6a+xrvtEyKdXPd+ucjWUWDrz8sGG9sx6ln2vTTKp33q110nfFUPpUfK0x9jTSkliubJf11hxbincFCOLlk7uXBlxjS6+cA+iKeMXY1dLBCmkRzM+O3D8cHhSNvI6KshbDQDKgRhjccvncSFUfouXczqO0UFeM3p6fGfzRmehC8sfe8sMPvhPlsJx+YVlimt8DVRWLXwXM6FVALcILEvWUH4wrUk08/LcFk4ntpU2MfMqgiCFhx0axvpYmOUzbm3p5JUlZLTyMTKaTkWwEp/niKHrWy7tjEMmi0jMjD7T7MugE4COko72/E9Ip6eybqarBOLoYeWQgiVmVTcoM2xf5L7rds4fHhWULLYph0nkHpJ1/4rBTwX5nNVqmsFhRuYcTUrEM/HfEoar2oki60M0Yg2e0lnKuALleb3gRFi2z+XLHjzPzUX8Du2MpxiZzOgCfOy1lMGP3tn3nieP2g/tpDel/on8wPpNCYeyW08pAkgATjxxjOV4H9dSv7gK44onIVLy+ZpQOGaPdwSWL4SQ8/jlv7XYM7OJh3oPkkJ9TPGc6e2YvPplzUR7oI5+7vfHtwCSaShF/tXkQSsfEEdGCYEuu44/iqnz0LyedLrLwGHNJ6p2ocsass9rPB+qo/KRQpYNl1SES6zdGQH9kD6ipM+UU0x95mHDwzZ05a2I4beo2Roe+gRvS/PgmCYBBecgS+C4dOQT/hsazmH2cQ8hDQ2Phzv/cmws0tPLgG9/B+iBi1QdJFr3UqJRZq4mFztPvXBUK3+iC1QbUOXU8Vj8TBVRErdUW4JwPl3lxzwETgyeOfhxeQQzBngAd3EfnLLaQWjVAWHsOpixKXAzHe9AkGQC9d95Vm1zh9enU3G8s/kBXJp1ZTcfamlATaAnboie+bWtZx+52lhbL4kgk6fPdcCxPZTKXbuGVZJz3etbqNb0YjtG0tJyosYbXeQP/9xcvp2MjIvds3708mJLhcfZqHSHnw6OHJYmtgJw7qTqQNytLHTsahPiZLjcqkNRndL1q/8YYsceFC2cGZxKuWAPOeqKlRxDSKa2zsTz2mKgmw1pkv4bUFmmW03R4yGzY99fYb4MO5HT6soVi8yn7gVoJciST38Vm/U24f/4sNs0Rz913mT4+nS/wyzfBqw+1Qu896tKmj9uvWecazf2PI8BESjYOpyZN6HJYZPfLm0TDmX+ca8scWSTZHLov2KzPPk5MfJyVGfK/7RSZNWjPD61i5Jvj5leGCex1KlZJ8nsf76fWXXS3MSS11f5lkejQ++hVDcxrPEoRcHt/As7weNZX3LriyESoNozEov0VRWFZvJtR2MwI0JOC8GEEtcXtpNbMSmnYrVp2Hnezk4jcaWnGD03pVFKQUqcSZSc2cyuNX6E7CqZBEH5fWTk+8HLm7QN5bSibGhTtCv3Qqrh210o3TiSu7xsBdOr2VIR5E1VsCKdSkpGG36DKYbHCCWKDFdf6JHj7pD7fFmn77RnbYmVqnZEtfot8NkqKDciv3JYsKw4o75M1tVm/5oQLe47gRA996te2MYW3f5/ssgve/Dk0Spcpf6FI7Mvb37strSLdhQp5l7leTkBeqlX/eNEKQy9t7l6aD7vf37sYveF0x58k6DmHkVn5lo7e5ASOjjR1goKT7mfsFbe5bRoy+qNpUsfdl/bvRagcrNhVY9QDXrWwkGJ6C3LiwS3b7Xlfq5hBvU+wTqfT8l/WPTJuV/QY2O5WxZfakZEIlTO1b09y2I7+fAzpY8G7ZB3DuZPLs/0hxyFHTtUhukHXqOMQUzxFJXmaEnEhIr4y0AI11xf2UQUUPfOF5vC0FX3d6q/nQk6FUL6UIIeuJMYjiiyXS7gm36unXdLhhy11tH1KU2I6lnDbZhOggz4TSgeKuAjzq/XKwRGE571/Rl49FgKcpf5gDKqJlZ9NZ8e4l9DbVcWuWiLoJ/8E2ItCNgSuf5E5cS0+Uqp0IVJw7ldUNwInAuNQJU292xdD2xMJxFriiiq6O+dDPBMF7yzJ7AHCK2mCiROj8hWSPPpj2IbI85hloK9iy/Sc4lTfqbAUjnRv7ZAchrz957bcWfsBV/ac/NG4c9erkJPE0fu/RjA/8Pl+Er8uAfINSnLuf1Qc/jfR2UgKepc0Qca38YPRonum9xnnqEkpMAdzAdE6OyUzkkhNBBGlG+BHI82H0w3n14+PAWafFu6MWDT0CO7HpXfiu+ANbmgnk/QoZKS6waG1TurrS7LhHwxJgUwoK93KrtRvdbDdgQ7VyXFV5FDmgrzg0+OGVs4w6YjA1cPSM//Yqb36B3riko2jtckvDUR50GpiN0e7u7uzKgLW8eogeK96+NSqmx+MZ0PyAbx1s2TMP4dInQUbcwlsg3vPxEqJZGy7t9ilW5e5WATyz7W9gb3skGlNAEGuO8TWcI9HqlQZlfr8JxeLQe9S3mW5fHpDJxFQoOAmL8pe35qiGkIKLZTA/vDZYkkGewrivrub6Tw93rg9PhIsbmOE/HGGIbnY1Hw7WdTgRXpcZ2ZB5P3l+/aof2/tWz59nebmKCVDPWcT1FkdbUnxeAlYej2wx7EwQpFvJ0T0Rc4PC2GBCVJWcTc+/a99vxAERiuv2L/YxfChF/eTN5nz08kC9GciPCImaQP/cqaexq2itvGvBiLMeBuuyaLTe9orAjHmuFwUyV8bynXdxvJ8fXlrRF76C7ouYluJvuPr4bFHO6uXJC7lohPE490gDo4d74T99wrv1H48NvzE8n77XMVgtMMPdsfyFB5fJ4cROESU/CMFXxYPeb+xCmgg2LOTSxOwoQWSYFBwuAeN20HXWXBcb7AWFWdgq+5nxp/Y40NEEDdprKuZ2VBfypdqJW/EbPP7DmvyUR/t/iwPyW+/nPL7z/gK0CUsiet7OvuFbQTHzTpmPLV5INvD2FCvfXULVTe4TvJcP7XE7Djsy7ZSjlyi7pWm6hr8e8arlxM73ajTL4toJmSgAD1e4u0lU9RlTSQAW/LEXx7XjvTwd7394mRRGHXjy8NV4YlFbPzia6bOaxeflMDMB4po8tTqqSuY83dKU7pm5iHFTSsRuf/W0STxOuW+baqyYFojryR9hP6qDUN03sBmPDD0bpCLkARvZKbG28LEP3pYF7qyWVmRHM4XXxGe1iTlX1wTHEVOLVhDZtFzubNnoGb8mbbWeVnTN+Wg/3muzoXhrkYg46XDkzztb6oBQfPtzrGARvy7LdGmqhHbsXqSAgh9niCUgn1pWhFptEmuwiwNIOq3sJDaUqgkTZuvlTdVtbhNqBPCZOR7rZ7Sy3xvIiEeD1XK8ZqOK1u00ib+6x9f01JzKzeg656STVRKS5US6MZH6qtLXeI2tB+SI2UoHnMLkrc0+623bKnZGOkxZ3WWlsZ9sUMM5QF/n1flcG0LMX3U0msTtdepsVCOpR66LQY2dluoVI8kSZZLhFAIRnAmiirI8kfYVJh7oqTfYxpNY8urQqxpfLVcW2ijmkma9m7YpnNocti/VmNeWVneLmNeDvatvgfpLn4X5dOUFqa33CVt2Z2CQRYjk0bS+yTgDIrMBCM2ZdSwlrIyXzU+m0gVn7tQbMia0/8SamSM2528gF7VFVeOfoUMWAZId1bpZbrl/JlfrkWCGRW2zu/fjdw937sWKuQicZCS1lg6RTB+6/XQOV8IQWVImnTE/fTu6nHZIV8VJmWcEhL1n6wW0YzQMbJyOzXZQbbRffksIITo42qy+TDPmJj8dzVkfKvlb345t3o6ER7B79reF/Z6J/y605n0cJ/yQgIBTWnLXTULc89gdbbDfBvC3acN5K193c/8qvL9uNHyH4h0cK/Fy51WdrFWBb+m88POZ/seDJH/4/eiXf7exiAAA=', 'base64')).toString('utf8');
const boundary = { since: '2026-10-16T06:56:00.000Z', until: '2026-10-19T02:33:49.881Z', identitySha256: 'a'.repeat(64) };
const CURRENT = { ...boundary, until: '2026-10-20T02:33:49.881Z' };
const dirs = [];
before(() => mock.method(Date, 'now', () => Date.parse('2026-10-20T05:00:00.000Z')));
after(() => { mock.restoreAll(); for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
function directory() { const d = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'daily-rss-')); dirs.push(d); return d; }
function descriptor(xml = ORIGINAL, changes = {}) {
    const bytes = Buffer.from(xml), hash = crypto.createHash('sha256').update(bytes).digest('hex');
    const filePath = path.join(directory(), `rss-eess.AS-${hash}.xml`);
    fs.writeFileSync(filePath, bytes, { mode: 0o600 });
    return { contract: CONTRACT, categoryId: 'eess.AS', boundaryIdentity: boundary.identitySha256,
        url: 'https://rss.arxiv.org/rss/eess.AS', retrievedAt: '2026-10-20T04:00:00.000Z',
        filePath, bytes: bytes.length, sha256: hash, ...changes };
}
function replay(xml = ORIGINAL, b = boundary) { return replayDailyAnnouncement(descriptor(xml), b, 'eess.AS'); }
test('real full Monday RSS covers Monday boundary and preserves all announcement types and 12 IDs', () => {
    const result = replay();
    assert.equal(result.ids.length, 12);
    assert.deepEqual([...new Set(result.items.map(v => v.announceType))], ['new', 'cross', 'replace', 'replace-cross']);
    assert.ok(result.ids.includes('2610.23539'));
    assert.ok(result.ids.includes('2404.05659'));
    assert.equal(result.pubDate, '2026-10-19T04:00:00.000Z');
    assert.equal(result.lastBuildDate, '2026-10-19T04:00:23.000Z');
    assert.equal(result.empty, false);
});
test('actual Monday feed never proves Tuesday fixed boundary', () => {
    assert.throws(() => replay(ORIGINAL, CURRENT), /stale\/future/);
});
test('fetch seals actual original XML and returns only original-file descriptor', async () => {
    let count = 0;
    const evidence = await fetchDailyAnnouncement('eess.AS', boundary, {
        evidenceDir: directory(), requestScheduler: { run: async (host, task, opts) => {
            assert.equal(host, 'rss.arxiv.org'); assert.equal(opts.minimumCooldownMs, 3000); return task();
        } }, requestFn: async (url, headers, proxy, timeout, cap) => {
            count++; assert.equal(url, 'https://rss.arxiv.org/rss/eess.AS'); assert.equal(timeout, 60000);
            assert.equal(cap, 16 * 1024 * 1024); return { status: 200, data: ORIGINAL };
        }
    });
    assert.equal(count, 1); assert.equal('ids' in evidence, false); assert.equal('covered' in evidence, false);
    assert.equal(fs.readFileSync(evidence.filePath, 'utf8'), ORIGINAL);
    assert.equal(replayDailyAnnouncement(evidence, boundary, 'eess.AS').ids.length, 12);
});
test('stale fetch preserves original response but grants no returned evidence', async () => {
    const evidenceDir = directory();
    await assert.rejects(fetchDailyAnnouncement('eess.AS', CURRENT,
        { evidenceDir, requestFn: async () => ({ status: 200, data: ORIGINAL }) }), /stale\/future/);
    assert.equal(fs.readdirSync(evidenceDir).length, 1);
});
test('fresh dated complete zero-item channel is an empty day, never a guessed success', () => {
    const empty = ORIGINAL.replace(/    <item>[\s\S]*?<\/item>\n/g, '');
    const result = replay(empty); assert.deepEqual(result.ids, []); assert.equal(result.empty, true);
    assert.throws(() => replay(empty.replace(/    <pubDate>[^<]+<\/pubDate>/, '')), /pubDate/);
});
const firstItem = ORIGINAL.match(/    <item>[\s\S]*?<\/item>\n/)[0];
for (const [name, transform, pattern] of [
    ['wrong channel category', x => x.replace('<title>eess.AS updates', '<title>cs.LG updates'), /category/],
    ['wrong channel link', x => x.replace('<link>http://rss.arxiv.org/rss/eess.AS</link>', '<link>http://rss.arxiv.org/rss/cs.LG</link>'), /category/],
    ['wrong self link', x => x.replace('href="http://rss.arxiv.org/rss/eess.AS"', 'href="http://rss.arxiv.org/rss/cs.LG"'), /self link/],
    ['missing channel date', x => x.replace(/    <pubDate>[^<]+<\/pubDate>/, ''), /pubDate/],
    ['missing build date', x => x.replace(/    <lastBuildDate>[^<]+<\/lastBuildDate>/, ''), /lastBuildDate/],
    ['future build', x => x.replace('Mon, 19 Oct 2026 04:00:23 +0000', 'Wed, 21 Oct 2026 04:00:23 +0000'), /stale\/future/],
    ['duplicate normalized ID', x => x.replace('  </channel>', firstItem + '  </channel>'), /duplicate normalized/],
    ['guid/link mismatch', x => x.replace('https://arxiv.org/abs/2610.22910', 'https://arxiv.org/abs/2610.99999'), /identity mismatch/],
    ['description ID mismatch', x => x.replace('arXiv:2610.22910v1 Announce Type', 'arXiv:2610.99999v1 Announce Type'), /description identity/],
    ['description announcement mismatch', x => x.replace('arXiv:2610.22910v1 Announce Type: new', 'arXiv:2610.22910v1 Announce Type: cross'), /description identity/],
    ['missing announce type', x => x.replace('<arxiv:announce_type>new</arxiv:announce_type>', ''), /announce_type/],
    ['unknown announce type', x => x.replace('<arxiv:announce_type>new</arxiv:announce_type>', '<arxiv:announce_type>unknown</arxiv:announce_type>'), /unknown announcement/],
    ['wrong item date', x => x.replace('<pubDate>Mon, 19 Oct 2026 00:00:00 -0400</pubDate>\n      <arxiv:', '<pubDate>Sun, 18 Oct 2026 00:00:00 -0400</pubDate>\n      <arxiv:'), /mixed announcement/],
    ['missing item category', x => x.replace('<category>eess.AS</category>', '<category>cs.LG</category>'), /category mismatch/],
    ['nested category', x => x.replace('<category>eess.AS</category>', '<category>eess.AS<foreign/></category>'), /nested category/],
    ['HTML masquerading as RSS', () => '<html><body>RSS service unavailable</body></html>', /RSS 2.0/],
    ['truncated XML', x => x.slice(0, -20), /XML replay failed/],
    ['DTD entity', x => '<!DOCTYPE rss [<!ENTITY x "fake">]>' + x.replace(/^<\?xml[^>]+>\n/, ''), /DTD\/entity/],
    ['next page', x => x.replace('  </channel>', '<atom:link rel="next" href="https://rss.arxiv.org/next"/>  </channel>'), /self link|paginated/],
    ['explicit truncation marker', x => x.replace('  </channel>', '<truncated>true</truncated>  </channel>'), /truncation/],
    ['2000 item possible truncation', x => x.replace(/    <item>[\s\S]*  <\/channel>/, firstItem.repeat(2000) + '  </channel>'), /truncation limit/]
]) test(`reject ${name} from original-file bytes`, () => assert.throws(() => replay(transform(ORIGINAL)), pattern));
test('cold replay rejects forged JSON IDs, coverage flags and descriptor URL/category drift', () => {
    const evidence = descriptor();
    for (const change of [{ ids: ['2610.00001'] }, { covered: true }, { url: 'http://rss.arxiv.org/rss/eess.AS' },
        { categoryId: 'cs.LG' }, { boundaryIdentity: 'b'.repeat(64) }, { sha256: '0'.repeat(64) },
        { retrievedAt: '2026-10-21T04:00:00.000Z' }]) {
        assert.throws(() => replayDailyAnnouncement({ ...evidence, ...change }, boundary, 'eess.AS'));
    }
    assert.throws(() => replayDailyAnnouncement({ ids: ['2610.23539'], covered: true }, boundary, 'eess.AS'));
});
test('each cold replay rereads bytes and rejects changed SHA/mode/hardlinks/symlinks', () => {
    const e = descriptor(); replayDailyAnnouncement(e, boundary, 'eess.AS');
    fs.writeFileSync(e.filePath, ORIGINAL.replace('Bridge, Distill', 'Changed, Distill'));
    assert.throws(() => replayDailyAnnouncement(e, boundary, 'eess.AS'), /changed|size/);
    const mode = descriptor(); fs.chmodSync(mode.filePath, 0o644);
    assert.throws(() => replayDailyAnnouncement(mode, boundary, 'eess.AS'), /mode/);
    const hard = descriptor(); fs.linkSync(hard.filePath, path.join(path.dirname(hard.filePath), 'other.xml'));
    assert.throws(() => replayDailyAnnouncement(hard, boundary, 'eess.AS'), /links/);
    const soft = descriptor(), target = path.join(path.dirname(soft.filePath), 'target.xml');
    fs.renameSync(soft.filePath, target); fs.symlinkSync(target, soft.filePath);
    assert.throws(() => replayDailyAnnouncement(soft, boundary, 'eess.AS'), /path/);
});
test('HTTP failure does not seal or grant announcement evidence', async () => {
    const evidenceDir = directory();
    await assert.rejects(fetchDailyAnnouncement('eess.AS', boundary,
        { evidenceDir, requestFn: async () => ({ status: 429, data: 'Rate exceeded' }) }), /HTTP 429/);
    assert.deepEqual(fs.readdirSync(evidenceDir), []);
});
test('cold replay rejects parent directory switched to symlink after the file read', t => {
    const evidence = descriptor(), parent = path.dirname(evidence.filePath), moved = parent + '-moved';
    const actualLstat = fs.lstatSync;
    let leafChecks = 0;
    t.mock.method(fs, 'lstatSync', function (filename, ...args) {
        // Initial full-path leaf check is the first call. The second leaf check
        // follows the actual read: preserve its inode but replace its parent.
        if (filename === evidence.filePath && ++leafChecks === 2) {
            fs.renameSync(parent, moved); dirs.push(moved); fs.symlinkSync(moved, parent);
        }
        return actualLstat.call(fs, filename, ...args);
    });
    assert.throws(() => replayDailyAnnouncement(evidence, boundary, 'eess.AS'), /path/);
    assert.equal(leafChecks, 2);
});
test('both public entries reject a reliable sandbox before evidence IO or any network dispatch', async t => {
    const evidence = descriptor(), previous = process.env.CODEX_SANDBOX;
    let io = 0, network = 0;
    for (const name of ['lstatSync', 'openSync', 'readFileSync']) {
        t.mock.method(fs, name, () => { io++; throw new Error('business IO must not start'); });
    }
    process.env.CODEX_SANDBOX = 'test-seatbelt';
    try {
        assert.throws(() => replayDailyAnnouncement(evidence, boundary, 'eess.AS'), /必须在沙箱外运行/);
        await assert.rejects(fetchDailyAnnouncement('eess.AS', boundary, {
            evidenceDir: path.dirname(evidence.filePath), requestFn: async () => {
                network++; return { status: 200, data: ORIGINAL };
            }
        }), /必须在沙箱外运行/);
        assert.equal(io, 0); assert.equal(network, 0);
    } finally {
        if (previous === undefined) delete process.env.CODEX_SANDBOX;
        else process.env.CODEX_SANDBOX = previous;
    }
});
