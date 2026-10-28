export async function customizeBootOptions(bootOptions) {
    // e.g.
    // return {
    //     ...bootOptions,
    //     additionalOptions: {
    //         ...bootOptions.additionalOptions,
    //         extensions: [
    //             ...bootOptions.additionalOptions.extensions,
    //             { pathRelativeToIndexHtml: 'myExtension' },
    //         ],
    //     },
    // }
    return bootOptions;
}