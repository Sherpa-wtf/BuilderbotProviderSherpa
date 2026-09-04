import { baileyCleanNumber, baileyGenerateImage, baileyIsPossibleNumber, baileyIsValidNumber, emptyDirSessions } from '../src/utils'
import { expect, describe, test, jest } from '@jest/globals'
import { utils } from '@builderbot/bot'
import { createWriteStream } from 'fs'
import * as qr from 'qr-image'
import { join } from 'path'
import fsExtra, { NoParamCallback } from 'fs-extra'

jest.mock('qr-image', () => ({
    image: jest.fn(() => ({
        pipe: jest.fn(),
    })),
}))

jest.mock('fs-extra', () => ({
    emptyDir: jest.fn((_path: string, callback: NoParamCallback) => callback(null)),
}))

jest.mock('@builderbot/bot', () => ({
    utils: {
        cleanImage: jest.fn(),
    },
}))

jest.mock('fs', () => ({
    createWriteStream: jest.fn().mockReturnValue({
        on: jest.fn(),
    }),
}))

describe('baileyCleanNumber', () => {
    test('should remove @s.whatsapp.net and + when full is true', () => {
        // Arrange
        const originalNumber = '+1234567890@s.whatsapp.net'
        // Act
        const cleanedNumber = baileyCleanNumber(originalNumber, true)
        // Assert
        expect(cleanedNumber).toEqual('1234567890')
    })
})

describe('#baileyIsValidNumber', () => {
    test('should return true if the number is valid', () => {
        // Arrange
        const validNumber = '+1234567890@s.whatsapp.net'

        // Act
        const isValid = baileyIsValidNumber(validNumber)

        // Assert
        expect(isValid).toBe(true)
    })

    test('should return false if the number is invalid', () => {
        // Arrange
        const invalidNumber = '+1234567890@g.us'

        // Act
        const isValid = baileyIsValidNumber(invalidNumber)

        // Assert
        expect(isValid).toBeFalsy()
    })

    test('should return true if the number does not contain @g.us', () => {
        // Arrange
        const numberWithoutGroup = '+1234567890@s.whatsapp.net'

        // Act
        const isValid = baileyIsValidNumber(numberWithoutGroup)

        // Assert
        expect(isValid).toBeTruthy()
    })

    test('should return true if the number is empty', () => {
        // Arrange
        const emptyNumber = ''

        // Act
        const isValid = baileyIsValidNumber(emptyNumber)

        // Assert
        expect(isValid).toBeTruthy()
    })
})

describe('#baileyGenerateImage', () => {
    test('should generate an image file from a base64 string', () => {
        // Arrange
        const base64 = 'yourBase64String'
        const imageName = 'test_image.png'
        const imagePath = join(process.cwd(), imageName)
        const mockWriteStream = {
            on: jest.fn(),
            write: jest.fn(),
            end: jest.fn(),
        }
        const mockPipe = jest.fn().mockReturnValue(mockWriteStream)
        const mockQrSvg = { pipe: mockPipe }
        ;(qr.image as jest.Mock).mockReturnValue(mockQrSvg)
        ;(createWriteStream as jest.Mock).mockReturnValue(jest.fn())

        // Act
        baileyGenerateImage(base64, imageName).then((result) => {
            // Assert
            expect(result).toBeTruthy()
            expect(qr.image).toHaveBeenCalledWith(base64, { type: 'png', margin: 4 })
            expect(utils.cleanImage).toHaveBeenCalledWith(imagePath)
            expect(createWriteStream).toHaveBeenCalledWith(imagePath)
            expect(mockWriteStream.on).toHaveBeenCalledWith('finish', expect.any(Function))
        })
    })
})

describe('#mockEmptyDir', () => {
    test('should empty the directory correctly', async () => {
        // Arrange
        const pathBase = '/path/to/directory'
        const mockEmptyDir = jest.fn((_path: string, callback: NoParamCallback) => callback(null))

        jest.spyOn(fsExtra, 'emptyDir').mockImplementation(mockEmptyDir)

        // Act
        await emptyDirSessions(pathBase)

        // Assert
        expect(mockEmptyDir).toHaveBeenCalledWith(pathBase, expect.any(Function))
    })

    test('should handle errors when emptying the directory', async () => {
        // Arrange
        const pathBase = '/path/to/directory'
        const error = new Error('Failed to empty directory')
        const mockEmptyDir = jest.fn((_path: string, callback: NoParamCallback) => callback(error))

        jest.spyOn(fsExtra, 'emptyDir').mockImplementation(mockEmptyDir)

        // Act & Assert
        await expect(emptyDirSessions(pathBase)).rejects.toEqual(error)
    })
})

/**
 * Regresión del 2026-09-04.
 *
 * Mandar a un número que no existe en WhatsApp NO falla en ninguna capa:
 * `getUSyncDevices` resuelve cero dispositivos, `relayMessage` cifra para
 * nadie, `sendMessage` resuelve OK con un id generado localmente, y no llega
 * ningún acuse jamás. El CRM se queda con `source_id: null` para siempre
 * mientras la UI muestra ✓✓.
 *
 * Reproducido contra producción mandando a `549111551260459` (el `15` de
 * discado local metido adentro): HTTP 200 "sended" en 637 ms, CERO eventos de
 * acuse, contra 38 acuses del mismo bot ese día con números reales.
 *
 * De 12 pérdidas confirmadas en 7 días, 11 eran números mal formados con
 * exactamente estas tres formas.
 */
describe('#baileyIsPossibleNumber', () => {
    test('rechaza las tres formas de número mal cargado que causaron pérdidas reales', () => {
        // El `15` de discado local metido adentro: 549 · 11 · 15 · 51260459
        expect(baileyIsPossibleNumber('549111551260459')).toBe(false)
        // El `0` del código de área: 549 · 011 · 37968697
        expect(baileyIsPossibleNumber('54901137968697')).toBe(false)
        // Truncado
        expect(baileyIsPossibleNumber('5494538173')).toBe(false)
        // Basura de carga
        expect(baileyIsPossibleNumber('549')).toBe(false)
    })

    test('acepta los números argentinos bien formados', () => {
        // Móvil: 54 · 9 · área · local = 13 dígitos
        expect(baileyIsPossibleNumber('5491151260459')).toBe(true)
        expect(baileyIsPossibleNumber('5493435209339')).toBe(true)
        expect(baileyIsPossibleNumber('5492932411976')).toBe(true)
        // Fijo: 54 · área · local = 12 dígitos
        expect(baileyIsPossibleNumber('543436114642')).toBe(true)
    })

    test('no rompe números de países que no tenemos modelados', () => {
        expect(baileyIsPossibleNumber('14155552671')).toBe(true)   // USA
        expect(baileyIsPossibleNumber('34612345678')).toBe(true)   // España
        expect(baileyIsPossibleNumber('5511987654321')).toBe(true) // Brasil
    })

    test('tolera el formato con el que llega el número en el resto del provider', () => {
        expect(baileyIsPossibleNumber('+54 9 11 5126-0459'.replace(/-/g, ''))).toBe(true)
        expect(baileyIsPossibleNumber('5491151260459@s.whatsapp.net')).toBe(true)
        expect(baileyIsPossibleNumber('')).toBe(false)
        expect(baileyIsPossibleNumber('no-es-un-numero')).toBe(false)
    })
})
