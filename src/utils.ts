import { utils } from '@builderbot/bot'
import type { WriteStream } from 'fs'
import { createWriteStream } from 'fs'
import { emptyDir } from 'fs-extra'
import * as qr from 'qr-image'

const emptyDirSessions = async (pathBase: string) =>
    new Promise((resolve, reject) => {
        emptyDir(pathBase, (err) => {
            if (err) reject(err)
            resolve(true)
        })
    })
/**
 * Cleans the WhatsApp number format.
 * @param number The WhatsApp number to be cleaned.
 * @param full Whether to return the full number format or not.
 * @returns The cleaned number.
 */
const baileyCleanNumber = (number: string, full: boolean = false): string => {
    const regexGroup: RegExp = /\@g.us\b/gm
    const exist = number.match(regexGroup)
    if (exist) return number
    number = number.replace('@s.whatsapp.net', '').replace('+', '').replace(/\s/g, '')
    number = !full ? `${number}@s.whatsapp.net` : number
    return number
}

/**
 * Comprueba que el numero PUEDA existir. No comprueba que exista en WhatsApp
 * (eso solo lo sabe WhatsApp, via `onWhatsApp`): descarta lo que es imposible
 * sin salir a la red.
 *
 * Por que hace falta: `baileyCleanNumber` solo saca `+` y espacios, y le pega
 * `@s.whatsapp.net` a cualquier cosa. Si el numero no existe, `getUSyncDevices`
 * de Baileys resuelve CERO dispositivos, `relayMessage` cifra el mensaje para
 * nadie, `sendMessage` resuelve OK con un id generado localmente, y no llega
 * ningun acuse jamas.
 *
 * Reproducido el 2026-09-04 mandando a `549111551260459` (15 digitos, el `15`
 * de discado local metido adentro): HTTP 200 "sended" en 637ms, CERO eventos de
 * acuse, contra 38 acuses del mismo bot ese dia con numeros reales.
 *
 * Las reglas por pais se aplican SOLO a los prefijos que conocemos. Para el
 * resto vale el rango generico de E.164, para no romper numeros de paises cuyo
 * plan de numeracion no tenemos modelado.
 */
const baileyIsPossibleNumber = (number: string): boolean => {
    const digits = String(number ?? '')
        .replace('@s.whatsapp.net', '')
        .replace('+', '')
        .replace(/\s/g, '')
    if (!/^[0-9]+$/.test(digits)) return false
    // El 0 inicial es discado nacional; nunca va en formato internacional.
    if (digits.startsWith('0')) return false
    // Rango generico de E.164.
    if (digits.length < 8 || digits.length > 15) return false

    // Argentina. Un movil es SIEMPRE `54` + `9` + 10 digitos = 13; un fijo es
    // `54` + 10 = 12. Cualquier otro largo con prefijo 54 es imposible, y es
    // exactamente la forma de los tres errores de carga que vimos en el CRM:
    // el `15` de discado local metido adentro (15 digitos), el `0` del area
    // (14) y numeros truncados (10-11).
    if (digits.startsWith('549')) return digits.length === 13
    if (digits.startsWith('54')) return digits.length === 12

    return true
}

/**
 * Generates an image from a base64 string.
 * @param base64 The base64 string to generate the image from.
 * @param name The name of the file to write the image to.
 */
const baileyGenerateImage = async (base64: string, name: string = 'qr.png'): Promise<void> => {
    const PATH_QR: string = `${process.cwd()}/${name}`
    const qr_svg = qr.image(base64, { type: 'png', margin: 4 })

    const writeFilePromise = (): Promise<boolean> =>
        new Promise((resolve, reject) => {
            const file: WriteStream = qr_svg.pipe(createWriteStream(PATH_QR))
            file.on('finish', () => resolve(true))
            file.on('error', reject)
        })

    await writeFilePromise()
    await utils.cleanImage(PATH_QR)
}

/**
 * Validates if the given number is a valid WhatsApp number and not a group ID.
 * @param rawNumber The number to validate.
 * @returns True if it's a valid number, false otherwise.
 */
const baileyIsValidNumber = (rawNumber: string): boolean => {
    const regexGroup: RegExp = /\@g.us\b/gm
    const exist = rawNumber.match(regexGroup)
    return !exist
}

export {
    baileyCleanNumber,
    baileyGenerateImage,
    baileyIsPossibleNumber,
    baileyIsValidNumber,
    emptyDirSessions
}
