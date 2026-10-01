{
  "targets": [{
    "target_name": "fuse",
    'variables': {
                    'fuse__include_dirs%': '<!(node scripts/fuse-config.js include-dirs)',
                    'fuse__library_dirs%': '',
                    'fuse__libraries%': '<!(node scripts/fuse-config.js libraries)'
                },
    "include_dirs": [
      "<!(node -e \"require('napi-macros')\")",
      "<@(fuse__include_dirs)"
    ],
    'library_dirs': [
                  '<@(fuse__library_dirs)',
    ],
    "link_settings": {
        "libraries": ["<@(fuse__libraries)"]},
    "libraries": [],
    "sources": [
      "fuse-native.c"
    ],
    'defines': [
      '_FILE_OFFSET_BITS=64'
    ],
    'conditions': [
      ['OS=="linux"', {
        'defines': [
          '_POSIX_C_SOURCE=200809L',
          '_DEFAULT_SOURCE'
        ]
      }]
    ],
    'xcode_settings': {
      'GCC_C_LANGUAGE_STANDARD': 'c11',
      'MACOSX_DEPLOYMENT_TARGET': '12.0',
      'OTHER_CFLAGS': [
        '-O3',
        '-Wall',
        '-Wextra',
        '-Wconversion',
        '-Wshadow',
        '-Wpedantic',
        '-Werror'
      ]
    },
    'cflags': [
      '-std=c11',
      '-O3',
      '-Wall',
      '-Wextra',
      '-Wconversion',
      '-Wshadow',
      '-Wpedantic',
      '-Werror'
    ],
  }, {
    "target_name": "postinstall",
    "type": "none",
    "dependencies": ["fuse"],
    "copies": [{
      "destination": "build/Release",
      "files": [  ],
    }]
  }]
}
